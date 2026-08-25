import { execOnClient } from './ssh/connection-manager'
import type { HostMetrics } from '@shared/types'

// Один прогон: два замера /proc/stat с паузой (для CPU%), память, диск, load, uptime, hostname.
// Работает на Linux-хостах; на прочих (BSD/сетевые устройства) вернётся ok:false.
const SCRIPT = [
  'LC_ALL=C',
  's1=$(head -1 /proc/stat)',
  'sleep 0.4',
  's2=$(head -1 /proc/stat)',
  'echo "CPU1 $s1"',
  'echo "CPU2 $s2"',
  'echo "MEM $(grep -E \'^(MemTotal|MemAvailable):\' /proc/meminfo | awk \'{print $2}\' | tr \'\\n\' \' \')"',
  'echo "DISK $(df -kP / | tail -1)"',
  'echo "LOAD $(cat /proc/loadavg)"',
  'echo "UP $(cat /proc/uptime)"',
  'echo "NPROC $(nproc 2>/dev/null || echo 1)"',
  'echo "HOST $(hostname 2>/dev/null)"'
].join('; ')

function cpuTotals(line: string): { total: number; idle: number } | null {
  // "CPU1 cpu  u n s idle iowait irq softirq steal ..."
  const parts = line.trim().split(/\s+/).slice(2).map(Number)
  if (parts.length < 5 || parts.some(isNaN)) return null
  const idle = parts[3] + (parts[4] || 0)
  const total = parts.reduce((a, b) => a + b, 0)
  return { total, idle }
}

export async function getHostMetrics(termId: string): Promise<HostMetrics> {
  const { stdout } = await execOnClient(termId, SCRIPT)
  const lines = Object.fromEntries(
    stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(' ')
        return [l.slice(0, i), l.slice(i + 1)]
      })
  ) as Record<string, string>

  const c1 = lines.CPU1 ? cpuTotals('x ' + lines.CPU1) : null
  const c2 = lines.CPU2 ? cpuTotals('x ' + lines.CPU2) : null
  let cpu = 0
  if (c1 && c2) {
    const dt = c2.total - c1.total
    const di = c2.idle - c1.idle
    cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0
  }

  let memTotal = 0
  let memUsed = 0
  if (lines.MEM) {
    const [total, avail] = lines.MEM.trim().split(/\s+/).map(Number)
    if (total) {
      memTotal = total * 1024
      memUsed = (total - (avail || 0)) * 1024
    }
  }

  let diskTotal = 0
  let diskUsed = 0
  if (lines.DISK) {
    // fs 1K-blocks used avail use% mount
    const f = lines.DISK.trim().split(/\s+/)
    const total = Number(f[1])
    const used = Number(f[2])
    if (total) {
      diskTotal = total * 1024
      diskUsed = used * 1024
    }
  }

  const load = lines.LOAD ? lines.LOAD.trim().split(/\s+/).slice(0, 3).map(Number) : [0, 0, 0]
  const uptime = lines.UP ? Math.floor(Number(lines.UP.trim().split(/\s+/)[0])) : 0
  const cores = lines.NPROC ? Number(lines.NPROC.trim()) || 1 : 1
  const hostname = lines.HOST?.trim() || ''

  const ok = memTotal > 0 || diskTotal > 0
  return {
    ok,
    cpu: Math.round(cpu),
    memUsed,
    memTotal,
    diskUsed,
    diskTotal,
    load: load as [number, number, number],
    uptime,
    cores,
    hostname
  }
}
