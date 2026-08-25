// Рендерит build/icon.html в PNG нескольких размеров и собирает multi-size .ico
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')
const { join } = require('path')

const dir = __dirname
const SIZES = [16, 24, 32, 48, 64, 128, 256]

function buildIco(pngs) {
  // pngs: [{size, buf}]
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(count, 4)
  const dirEntries = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  const bodies = []
  pngs.forEach((p, i) => {
    const e = i * 16
    dirEntries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 0) // width
    dirEntries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1) // height
    dirEntries.writeUInt8(0, e + 2) // colors
    dirEntries.writeUInt8(0, e + 3) // reserved
    dirEntries.writeUInt16LE(1, e + 4) // planes
    dirEntries.writeUInt16LE(32, e + 6) // bpp
    dirEntries.writeUInt32LE(p.buf.length, e + 8) // size
    dirEntries.writeUInt32LE(offset, e + 12) // offset
    offset += p.buf.length
    bodies.push(p.buf)
  })
  return Buffer.concat([header, dirEntries, ...bodies])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: false }
  })
  await win.loadFile(join(dir, 'icon.html'))
  await new Promise((r) => setTimeout(r, 600))
  const full = await win.webContents.capturePage()

  // 512 PNG (для macOS/Linux и как исходник)
  writeFileSync(join(dir, 'icon.png'), full.toPNG())

  const pngs = SIZES.map((size) => ({
    size,
    buf: full.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))
  writeFileSync(join(dir, 'icon.ico'), buildIco(pngs))

  console.log('ICON_OK sizes=' + SIZES.join(','))
  app.exit(0)
})
