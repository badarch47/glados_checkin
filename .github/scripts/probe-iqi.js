// 每小时采集一次 GLaDOS 网络质量指数（IQI / Cable Bonus 用的 score）
// 目的：积累小时级样本，找出一天中指数最低（签到加成最高）的时段。
// 输出：单行结构化日志，便于事后从 Actions 日志里批量解析。
//   格式 IQI_SAMPLE|<UTC ISO>|<北京时间>|<score>|<带宽Mbps>|<延迟ms>|<cablePoints>|<level>|<服务端快照时间戳>
// 注意：服务端每小时 :42 左右才重算一次，因此本脚本应由 cron 安排在每小时 :50 运行，
// 才能取到「属于该小时」的那份快照；若在 :42 之前运行，拿到的是上一小时的值。

const DOMAIN = process.env.DOMAIN || 'glados.cloud'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36'

// 依次尝试多个账号的 Cookie；IQI 是节点级公共数据，用哪个账号结果都一样
const pickCookie = () => {
  for (const name of ['GLADOS', 'GLADOS2', 'GLADOS3']) {
    const raw = String(process.env[name] ?? '')
      .split(/\r?\n/)[0]
      .trim()
      .replace(/^["']|["']$/g, '')
    if (raw) return { name, cookie: raw }
  }
  return null
}

const main = async () => {
  const picked = pickCookie()
  if (!picked) {
    console.log('IQI_SAMPLE|NO_COOKIE|未配置 GLADOS / GLADOS2 / GLADOS3')
    process.exit(1)
  }

  const res = await fetch(`https://${DOMAIN}/api/user/network-insight`, {
    headers: {
      cookie: picked.cookie,
      referer: `https://${DOMAIN}/console/checkin`,
      'user-agent': UA,
    },
  })
  const json = await res.json()
  if (json.code !== 0) {
    console.log(`IQI_SAMPLE|ERR|code=${json.code}|${json.message || ''}|来源=${picked.name}`)
    process.exit(1)
  }

  const d = json.data || {}
  const c = d.current || {}
  if (c.score == null) {
    console.log('IQI_SAMPLE|ERR|接口未返回 score')
    process.exit(1)
  }

  const now = Date.now()
  const iso = new Date(now).toISOString()
  const bj = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
  const snapshotAge = d.updatedAt ? ((now - d.updatedAt) / 60000).toFixed(1) : '?'

  console.log(
    [
      'IQI_SAMPLE',
      iso,
      bj,
      c.score,
      Number(c.bandwidth).toFixed(3),
      Number(c.latency).toFixed(1),
      c.cablePoints ?? '-',
      c.level || '-',
      d.updatedAt || '-',
    ].join('|')
  )
  console.log(`采集来源账号: ${picked.name}｜快照年龄: ${snapshotAge} 分钟`)
}

main().catch((err) => {
  console.log(`IQI_SAMPLE|EXC|${err.message}`)
  process.exit(1)
})
