import { createHash } from 'node:crypto'

// ========== 工具函数：敏感信息脱敏 ==========
const mask = (str, startLen = 4, endLen = 4) => {
  if (!str || typeof str !== 'string') return '***'
  if (str.length <= startLen + endLen) return '*'.repeat(str.length)
  return str.slice(0, startLen) + '****' + str.slice(-endLen)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ========== 默认 UA ==========
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// ========== 签到挑战（challenge）协议常量 ==========
// 逆向自 glados.cloud 前端 main~20e9f87d.chunk.js 模块 613：
//   checkinProof(nonce) = SHA256_HEX(nonce + "." + "glados-observe-v1")
// 全流程：
//   1) GET  /api/user/checkin/challenge  -> { code:0, nonce, ttl }
//   2) 等待 >= 2500ms（前端强制的人类反应时间下限）
//   3) POST /api/user/checkin  body: { token:<hostname>, nonce, proof }
// 缺 nonce/proof 的裸请求服务端仍返回 code:0，但只给 Base 档保底积分。
const PROOF_SALT = 'glados-observe-v1'
const MIN_HUMAN_DELAY_MS = 2500 // 前端硬性下限
const EXCELLENT_DELAY_MAX_MS = 5000 // 前端评级 excellent 上限（<=5s）

const checkinProof = (nonce) =>
  createHash('sha256').update(`${nonce}.${PROOF_SALT}`, 'utf8').digest('hex')

// ========== 积分构成（一律以服务端下发为准） ==========
// 签到响应里的 breakdown 字段由服务端结算生成，前端结算卡片直接渲染它，
// 逆向自 renderSettlement()：
//   points  = base + level + streak + cable + lucky + site + exitIp
//   base    随机基础分（每日必给，非固定值）
//   level   套餐加成（Pro +1 / Team +1.5 / Enterprise +2）
//   streak  连续签到加成（>7 天 +1，>=15 天 +2）
//   cable   光缆加成，取值见 /api/user/network-insight 的 current.cablePoints
//   lucky   幸运加成；site 站点加成；exitIp 出口 IP 加成
// 注意：不要再用本地公式反推积分构成。此前用「Base1 + 套餐 + 连续 + 光缆」
// 估算理论下限，光缆档位阈值写的是 80/85/90/95，与服务端实际档位
// （90/95/100/110/131，档位分值 9/7/5/3/2/1）不符，会把正常得分误判为异常，
// 也会把实际加成显示成错误数值。
const BREAKDOWN_ORDER = [
  ['base', '基础'],
  ['level', '套餐'],
  ['streak', '连续'],
  ['cable', '光缆'],
  ['lucky', '幸运'],
  ['site', '站点'],
  ['exitIp', '出口IP'],
]

const toNum = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const formatBreakdown = (bd) => {
  if (!bd) return ''
  return BREAKDOWN_ORDER.map(([key, label]) => [label, toNum(bd[key])])
    .filter(([, v]) => v !== 0)
    .map(([label, v]) => `${label}+${v}`)
    .join(' / ')
}

const breakdownSum = (bd) => BREAKDOWN_ORDER.reduce((sum, [key]) => sum + toNum(bd?.[key]), 0)

// 光缆档位兜底换算：服务端 tiers 与前端判定边界一致（[90,95,100,110,131]）
const cablePointsByTiers = (score, tiers) => {
  const s = Number(score)
  if (!Number.isFinite(s) || !Array.isArray(tiers) || !tiers.length) return null
  const bounds = [90, 95, 100, 110, 131]
  for (let i = 0; i < bounds.length; i++) {
    if (s < bounds[i]) return toNum(tiers[i]?.points) || null
  }
  return toNum(tiers[tiers.length - 1]?.points) || null
}

// ========== 判定辅助：服务端是否「看起来成功、实际降级」 ==========
// 协议变更时服务端未必直接报错，可能返回 code:0 但只给 Base 保底分，
// 或返回 code:1 假装已签到。因此不能只看 code，必须交叉核对得分与流水。
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

const beijingDate = (input) => {
  if (input == null) return null
  const ms = typeof input === 'number' ? (input < 1e12 ? input * 1000 : input) : new Date(input).getTime()
  if (!Number.isFinite(ms)) return null
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

const todayBeijing = () => beijingDate(Date.now())

// 从积分流水里判断今天是否真有记录：true / false / null(结构无法解析)
const hasRecordToday = (list) => {
  if (!Array.isArray(list) || list.length === 0) return null
  const today = todayBeijing()
  const dates = list
    .slice(0, 8)
    .map((it) => beijingDate(it?.time ?? it?.createdAt ?? it?.created_at ?? it?.date))
    .filter(Boolean)
  if (!dates.length) return null
  return dates.includes(today)
}

// ========== 浏览器请求头构造 ==========
// 浏览器发起签到时会带上 sec-ch-ua / sec-fetch-* 等一组头部，
// 这些头部与 UA 中的平台、内核大版本必须自洽，否则容易被判为伪造。
const detectPlatform = (ua) => {
  const s = String(ua || '')
  if (/Android/i.test(s)) return { platform: 'Android', mobile: '?1' }
  if (/iPhone|iPad|iPod/i.test(s)) return { platform: 'iOS', mobile: '?1' }
  if (/Windows/i.test(s)) return { platform: 'Windows', mobile: '?0' }
  if (/Macintosh|Mac OS X/i.test(s)) return { platform: 'macOS', mobile: '?0' }
  if (/Linux/i.test(s)) return { platform: 'Linux', mobile: '?0' }
  return { platform: 'macOS', mobile: '?0' }
}

const detectChromeMajor = (ua) => {
  const m = String(ua || '').match(/Chrome\/(\d+)/)
  return m ? m[1] : '140'
}

const buildBrowserHeaders = (ua, domain) => {
  const { platform, mobile } = detectPlatform(ua)
  const major = detectChromeMajor(ua)
  const isChromiumLike = /Chrome|Chromium|Edg\//i.test(String(ua))
  const headers = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: `https://${domain}`,
    referer: `https://${domain}/console/checkin`,
    'user-agent': ua,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  }
  if (isChromiumLike) {
    headers['sec-ch-ua'] = `"Chromium";v="${major}", "Not=A?Brand";v="24", "Google Chrome";v="${major}"`
    headers['sec-ch-ua-mobile'] = mobile
    headers['sec-ch-ua-platform'] = `"${platform}"`
  }
  return headers
}

// ========== Cookie 结构诊断 ==========
const REQUIRED_COOKIE_FIELDS = [
  { label: 'gld:sess', variants: ['gld:sess', 'gld_sess'] },
  { label: 'gld:sess.sig', variants: ['gld:sess.sig', 'gld_sess.sig'] },
]

const OPTIONAL_COOKIE_FIELDS = [
  { label: 'koa:sess', variants: ['koa:sess', 'koa.sess'] },
  { label: 'koa:sess.sig', variants: ['koa:sess.sig', 'koa.sess.sig'] },
  { label: 'gld:accts', variants: ['gld:accts', 'gld_accts'] },
  { label: 'gld:accts.sig', variants: ['gld:accts.sig', 'gld_accts.sig'] },
]

const parseCookieNames = (cookie) =>
  String(cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq === -1) return `(缺少name)${part.slice(0, 4)}…`
      return part.slice(0, eq).trim()
    })

const diagnoseCookie = (cookie) => {
  const raw = String(cookie || '')
  const names = parseCookieNames(raw)
  const named = names.filter((n) => !n.startsWith('(缺少name)'))
  const has = (group) => group.variants.some((v) => named.includes(v))
  return {
    names,
    named,
    hasAssign: raw.includes('='),
    missing: REQUIRED_COOKIE_FIELDS.filter((g) => !has(g)).map((g) => g.label),
    optionalMissing: OPTIONAL_COOKIE_FIELDS.filter((g) => !has(g)).map((g) => g.label),
  }
}

// ========== 多账号环境变量收集 ==========
const MAX_ACCOUNT_SLOTS = 20

const splitEnvLines = (value) =>
  String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)

const resolveUaList = (slot) => {
  const candidates =
    slot === 1 ? ['GLADOS_UA'] : [`GLADOS_UA${slot}`, `GLADOS${slot}_UA`]
  for (const name of candidates) {
    const lines = splitEnvLines(process.env[name])
    if (lines.length) return { list: lines, source: name }
  }
  return { list: splitEnvLines(process.env.GLADOS_UA), source: 'GLADOS_UA(回退)' }
}

const collectAccounts = () => {
  const accounts = []
  const seen = new Map()

  for (let slot = 1; slot <= MAX_ACCOUNT_SLOTS; slot++) {
    const envName = slot === 1 ? 'GLADOS' : `GLADOS${slot}`
    const cookies = splitEnvLines(process.env[envName])
    if (!cookies.length) continue

    const { list: uaList, source: uaSource } = resolveUaList(slot)
    cookies.forEach((cookie, i) => {
      if (seen.has(cookie)) {
        console.log(
          `⚠️  ${envName} 中第 ${i + 1} 条 Cookie 与 ${seen.get(cookie)} 中的记录重复，已自动跳过`
        )
        return
      }
      seen.set(cookie, envName)
      const ua = uaList[i] || uaList[0] || DEFAULT_UA
      accounts.push({
        envName,
        cookie,
        ua,
        uaSource: ua === DEFAULT_UA ? '内置默认UA' : uaSource,
      })
    })
  }

  return accounts
}

// ========== 带挑战的签到 ==========
const doCheckin = async (domain, headers) => {
  // 1) 取挑战
  const chRes = await fetch(`https://${domain}/api/user/checkin/challenge`, {
    method: 'GET',
    headers,
  })
  if (!chRes.ok) throw new Error(`挑战接口HTTP错误: ${chRes.status} ${chRes.statusText}`)
  const ch = await chRes.json()
  if (ch?.code !== 0 || !ch?.nonce) {
    throw new Error(`获取签到挑战失败: ${ch?.message || '未返回 nonce'} (code=${ch?.code})`)
  }
  const ttl = Number(ch.ttl) || 300000
  console.log(`  挑战已获取: nonce=${mask(String(ch.nonce), 6, 4)} ttl=${ttl}ms`)
  // 诊断：打印挑战响应的完整结构（nonce 脱敏）。
  // 服务端 2026-11-14 起在签到返回 code=5 / reason=turnstile，
  // 需要确认挑战接口是否已经下发 sitekey / turnstile 之类的新字段。
  console.log(
    '  挑战响应结构: ' +
      JSON.stringify(ch, (k, v) => (k === 'nonce' ? mask(String(v), 6, 4) : v))
  )

  // 2) 等待人类反应时间（前端下限 2500ms，落在 excellent 档 <=5s）
  const wait = MIN_HUMAN_DELAY_MS + 300 + Math.floor(Math.random() * 1700)
  console.log(`  等待 ${wait}ms 后提交（模拟人类反应，excellent 档 <=${EXCELLENT_DELAY_MAX_MS}ms）`)
  await sleep(wait)

  // 3) 计算 proof 并提交
  const proof = checkinProof(String(ch.nonce))
  console.log(`  proof=${mask(proof, 8, 8)}`)

  const res = await fetch(`https://${domain}/api/user/checkin`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ token: domain, nonce: ch.nonce, proof }),
  })
  if (!res.ok) throw new Error(`签到接口HTTP错误: ${res.status} ${res.statusText}`)
  const body = await res.json()
  if (body?.code !== 0) {
    // 诊断：Cloudflare 拦截时通常会带 cf-mitigated 头，可据此区分「业务拒绝」与「风控拦截」
    console.log(
      `  签到失败响应头: cf-mitigated=${res.headers.get('cf-mitigated') || '-'}` +
        ` server=${res.headers.get('server') || '-'}` +
        ` cf-ray=${res.headers.get('cf-ray') || '-'}`
    )
    console.log(`  签到失败响应体: ${JSON.stringify(body)}`)
  }
  return body
}

// ========== 网络质量指数（光缆加成的权威来源） ==========
// /api/user/network-insight 返回：
//   data.current = { score, level, cablePoints, ... }
//   data.tiers   = [{ label:'90–94', points:7 }, ...]
// cablePoints 就是本次签到可拿到的光缆加成，直接采用，不做本地换算。
const getNetworkInsight = async (domain, headers) => {
  const res = await fetch(`https://${domain}/api/user/network-insight`, { method: 'GET', headers })
  if (!res.ok) throw new Error(`network-insight HTTP错误: ${res.status}`)
  const body = await res.json()
  if (body?.code !== 0) throw new Error(`network-insight 返回异常 (code=${body?.code})`)
  const cur = body?.data?.current || {}
  return {
    score: cur.score ?? null,
    level: cur.level ?? null,
    cablePoints: cur.cablePoints ?? null,
    tiers: body?.data?.tiers || [],
  }
}

// ========== 签到时间窗口守候 ==========
// GitHub Actions 的 schedule 只会「推迟」，永远不会提前：本仓库实测延迟 0～8.2 小时，
// 中位数约 4.6 小时，且官方不承诺任何上限。这带来两个硬约束：
//   1) cron 必须提前触发，把「最晚落点」压在当天之内。一旦跨过北京零点，
//      这次签到会被算到第二天，等于今天漏签、明天顶掉，净亏一天积分。
//   2) 想让签到固定在 IQI 较低的晚间，就不能依赖 cron 自身的落点，
//      只能在进程内部把时间「等」到位。
// 于是：cron 定在北京 14:20 触发（UTC 06:20），脚本启动后等到北京 19:30 再签。
//   最早 14:20 触发 → 原地等 5 小时 10 分 → 19:30 签到
//   最晚 22:32 触发 → 已过窗口 → 立即签到 → 22:32 签到
//   两种落点都在当天之内，且都落在晚间低值区。
// 目标时刻可用环境变量 CHECKIN_WINDOW_START=HH:MM 覆盖，留空则用默认 19:30。
const BJ_OFFSET_MS = 8 * 3600 * 1000
const MAX_WAIT_MS = 5.5 * 3600 * 1000 // 单 job 上限 6 小时，留 30 分钟给安装与签到

const pad2 = (n) => String(n).padStart(2, '0')

// 用 UTC 取值器读出「北京时间」的各分量，避免受 runner / 本机时区影响
const bjParts = (ts = Date.now()) => {
  const d = new Date(ts + BJ_OFFSET_MS)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  }
}

const bjStamp = (ts) => {
  const p = bjParts(ts)
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`
}

const parseWindowStart = () => {
  const raw = String(process.env.CHECKIN_WINDOW_START || '19:30').trim()
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    console.log(`[时间窗口] CHECKIN_WINDOW_START="${raw}" 不是合法的 HH:MM，已回退默认 19:30`)
    return { h: 19, m: 30 }
  }
  return { h: Number(m[1]), m: Number(m[2]) }
}

const waitForWindow = async () => {
  // 手动触发（workflow_dispatch）语义是「现在就要签」——补签、排障、验证都走这条路，
  // 不该被窗口守候拦住白等几个小时。定时触发才走守候逻辑。
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    console.log(`[时间窗口] 本次为手动触发，跳过守候，立即签到（北京 ${bjStamp()}）`)
    return
  }
  const { h, m } = parseWindowStart()
  const p = bjParts()
  const nowMs = ((p.h * 60 + p.mi) * 60 + p.s) * 1000
  const targetMs = (h * 60 + m) * 60 * 1000
  const waitMs = targetMs - nowMs

  if (waitMs <= 0) {
    console.log(`[时间窗口] 当前北京 ${bjStamp()}，已过窗口起点 ${pad2(h)}:${pad2(m)}，立即执行签到`)
    return
  }
  if (waitMs > MAX_WAIT_MS) {
    console.log(
      `[时间窗口] 当前北京 ${bjStamp()}，距 ${pad2(h)}:${pad2(m)} 还有 ${(waitMs / 3600000).toFixed(2)} 小时，` +
        `超出单 job 6 小时的安全等待范围，改为立即签到`
    )
    if (p.h < 6) {
      console.log(
        '[时间窗口] ⚠️  本次触发已跨过北京零点，说明这一轮延迟超出预期（实测长尾 8.2 小时）。' +
          '签到会记在今天，昨天那份需要到网页端手动补签。'
      )
    }
    return
  }

  console.log(
    `[时间窗口] 当前北京 ${bjStamp()}，原地等待 ${(waitMs / 60000).toFixed(1)} 分钟，到 ${pad2(h)}:${pad2(m)} 再签到`
  )
  const deadline = Date.now() + waitMs
  // 每 10 分钟打一行心跳，长时间静默容易被误判成卡死
  while (Date.now() < deadline - 10 * 60 * 1000) {
    await sleep(10 * 60 * 1000)
    const left = Math.round((deadline - Date.now()) / 60000)
    if (left > 0) {
      console.log(`[时间窗口] 心跳：距签到还有约 ${left} 分钟（北京 ${bjStamp()}）`)
    }
  }
  const rest = deadline - Date.now()
  if (rest > 0) await sleep(rest)
  console.log(`[时间窗口] 已到窗口起点，北京 ${bjStamp()}，开始签到`)
}

// ========== GLaDOS 签到核心逻辑 ==========
const glados = async () => {
  const notice = []
  const pointsSummary = []
  let successCount = 0
  let failCount = 0
  let criticalAnomalies = 0
  console.log('========== GLaDOS 签到任务开始 ==========')

  const accounts = collectAccounts()
  if (!accounts.length) {
    console.log('⚠️  未配置 GLADOS / GLADOS2 / GLADOS3… 任一环境变量，跳过签到任务')
    return notice
  }

  const sources = [...new Set(accounts.map((a) => a.envName))]
  console.log(`📋 共检测到 ${accounts.length} 个账号`)
  console.log(`📋 环境变量来源: ${sources.join('、')}`)

  for (const [index, account] of accounts.entries()) {
    const accountNo = index + 1
    const tag = `账号 ${accountNo}|${account.envName}`
    const anomalies = []
    console.log(`\n[${tag}] ---------- 开始处理 ----------`)
    console.log(`[${tag}] Cookie: ${mask(account.cookie)}`)

    const diag = diagnoseCookie(account.cookie)
    console.log(`[${tag}] Cookie 字段(${diag.named.length}): ${diag.named.join('、') || '无'}`)
    if (!diag.hasAssign) {
      console.log(
        `[${tag}] ⚠️ Cookie 不含 "name=value" 结构，可能只粘贴了值；请从 DevTools → Network → 该请求的 Cookie 请求头整行复制`
      )
    }
    if (diag.missing.length) {
      console.log(
        `[${tag}] ⚠️ 缺少必需字段: ${diag.missing.join('、')}——实测缺任意一项都会返回 code=-2，请重新完整复制 Cookie`
      )
    } else if (diag.optionalMissing.length) {
      console.log(`[${tag}] ℹ️ 未包含可选项: ${diag.optionalMissing.join('、')}（不影响鉴权）`)
    }

    try {
      const domain = process.env.DOMAIN || 'glados.cloud'
      const ua = account.ua
      const headers = { ...buildBrowserHeaders(ua, domain), cookie: account.cookie }

      console.log(`[${tag}] 目标域名: ${domain}`)
      console.log(`[${tag}] UA(${account.uaSource}): ${mask(ua, 8, 8)}`)

      // 1. 带挑战签到
      console.log(`[${tag}] 正在执行签到请求（含 challenge）...`)
      const action = await doCheckin(domain, headers)
      console.log(`[${tag}] 签到接口响应码: ${action?.code ?? '无'}`)

      const alreadyCheckedIn = action?.code === 1
      if (action?.code === 4 && action?.reason === 'device-mismatch') {
        throw new Error(
          `设备校验不通过（device-mismatch）：当前 UA/会话与登录设备不一致。` +
            `loginDevice=${action?.loginDevice || '?'} currentDevice=${action?.currentDevice || '?'}。` +
            `请用同一浏览器重新登录并同步更新 Cookie 与 GLADOS_UA`
        )
      }
      if (action?.code !== 0 && !alreadyCheckedIn) {
        throw new Error(
          `${action?.message || '签到失败'} (code=${action.code}${action?.reason ? ', reason=' + action.reason : ''})`
        )
      }
      let gained = null
      let breakdown = null
      if (alreadyCheckedIn) {
        console.log(`[${tag}] 今日已签到过，继续查询剩余天数与积分...`)
      } else {
        gained = Number(action?.points)
        breakdown = action?.breakdown || action?.settlement || null
        console.log(
          `[${tag}] 本次获得积分: ${Number.isFinite(gained) ? gained + ' 分' : '未返回'} | 服务端消息: ${action?.message || ''}`
        )
        if (breakdown) {
          console.log(
            `[${tag}] 🧾 服务端结算: 总计+${toNum(breakdown.points ?? gained)} = ${
              formatBreakdown(breakdown) || '无加成项'
            }`
          )
        } else {
          console.log(
            `[${tag}] ℹ️ 签到响应未带 breakdown，无法展示逐项构成；响应字段: ${Object.keys(action || {}).join(',')}`
          )
        }
      }

      // 2. 账号状态
      console.log(`[${tag}] 正在获取账号状态...`)
      const statusRes = await fetch(`https://${domain}/api/user/status`, { method: 'GET', headers })
      if (!statusRes.ok) throw new Error(`状态接口HTTP错误: ${statusRes.status} ${statusRes.statusText}`)
      const status = await statusRes.json()
      console.log(`[${tag}] 状态接口响应码: ${status?.code ?? '无'}`)
      if (status?.code !== 0) {
        throw new Error(`登录状态异常: ${status?.message || '未知错误'} (code=${status.code})`)
      }
      const leftDays = Number(status?.data?.leftDays)

      // 3. 积分 + 加成构成
      let currentPoints = null
      let bonusLine = ''
      try {
        console.log(`[${tag}] 正在获取积分...`)
        const pointsRes = await fetch(`https://${domain}/api/user/points`, { method: 'GET', headers })
        if (!pointsRes.ok) throw new Error(`积分接口HTTP错误: ${pointsRes.status}`)
        const pointsData = await pointsRes.json()
        if (pointsData?.code !== 0) {
          throw new Error(`获取积分失败: ${pointsData?.message || '未知错误'}`)
        }
        currentPoints = Number(pointsData?.points) || 0
        const streak = pointsData?.streak ?? 0
        const history = pointsData?.history || pointsData?.list || []
        console.log(`[${tag}] 💰 当前积分: ${currentPoints} 点 | 连续签到: ${streak} 天`)
        pointsSummary.push(`账号${accountNo}(${account.envName}): ${currentPoints} 点 / 连续 ${streak} 天`)

        // 4. 光缆加成：以服务端 network-insight 的 cablePoints 为准
        let cable = null
        try {
          const insight = await getNetworkInsight(domain, headers)
          cable = insight.cablePoints
          let cableNote = ''
          if (cable == null && insight.score != null) {
            cable = cablePointsByTiers(insight.score, insight.tiers)
            cableNote = '（由 tiers 兜底换算）'
          }
          console.log(
            `[${tag}] 光缆指数: ${insight.score ?? '未取到'} (${insight.level ?? '?'}) | 光缆加成: ${
              cable == null ? '未取到' : '+' + cable
            }${cableNote}`
          )
          if (insight.tiers.length) {
            console.log(
              `[${tag}] 档位表: ${insight.tiers.map((t) => `${t.label}:+${t.points}`).join(' | ')}`
            )
          }
        } catch (insightErr) {
          console.log(`[${tag}] ℹ️ 光缆指数获取失败: ${insightErr.message}`)
        }

        // 5. 结算校验：只核对服务端给的 breakdown，不再用本地公式反推下限
        if (breakdown) {
          const declared = toNum(breakdown.points ?? gained)
          const summed = breakdownSum(breakdown)
          bonusLine = formatBreakdown(breakdown)
          console.log(`[${tag}] 📈 积分构成: ${bonusLine || '无加成项'} → 合计 ${summed} 分`)
          if (!alreadyCheckedIn && Number.isFinite(gained) && declared !== gained) {
            anomalies.push({
              level: 'warning',
              text: `结算明细总计 ${declared} 分与接口返回的 ${gained} 分不一致`,
            })
          }
          if (Math.abs(summed - declared) > 1e-6) {
            anomalies.push({
              level: 'warning',
              text: `结算明细各分项之和 ${summed} 与总计 ${declared} 不一致，可能存在未识别的加成项`,
            })
            console.log(
              `[${tag}] ⚠️ 分项之和 ${summed} 与总计 ${declared} 不一致，前端可能新增了加成项`
            )
          }
        } else if (cable != null && !alreadyCheckedIn) {
          bonusLine = `光缆+${cable}`
          console.log(
            `[${tag}] ℹ️ 无 breakdown，仅能参考光缆加成 +${cable}，本次实得 ${
              gained == null ? '未知' : gained + ' 分'
            }`
          )
        }
        if (!alreadyCheckedIn && Number(streak) === 0) {
          anomalies.push({
            level: 'warning',
            text: '签到成功但连续天数为 0，Streak 加成将无法累计',
          })
          console.log(`[${tag}] 🚨 连续天数异常: 签到成功却 streak=0`)
        }
        if (alreadyCheckedIn) {
          const recorded = hasRecordToday(history)
          if (recorded === false) {
            anomalies.push({
              level: 'critical',
              text: '返回「今日已签到」但积分流水中没有今天的记录',
            })
            console.log(
              `[${tag}] 🚨 状态矛盾: 响应称今日已签到，但流水无今日记录，服务端可能改用其他 code 表达降级`
            )
          } else if (recorded === null) {
            console.log(`[${tag}] ℹ️ 积分流水结构无法解析，跳过今日记录校验`)
          } else {
            console.log(`[${tag}] ✅ 已签到状态校验通过: 流水含今日记录`)
          }
        }
      } catch (pointsErr) {
        console.warn(`[${tag}] ⚠️ 积分查询失败: ${pointsErr.message}`)
        pointsSummary.push(`账号${accountNo}(${account.envName}): 查询失败`)
      }

      // 5. 自动兑换
      const autoExchange = String(process.env.AUTO_EXCHANGE || 'true').toLowerCase() !== 'false'
       console.log(`[${autoExchange}]`)
      const exchangeThreshold = Number(process.env.EXCHANGE_THRESHOLD || 500)
      if (autoExchange && currentPoints != null && currentPoints >= exchangeThreshold) {
        try {
          console.log(`[${tag}] 积分 ${currentPoints} ≥ ${exchangeThreshold}，自动兑换 100 天...`)
          const exRes = await fetch(`https://${domain}/api/user/exchange`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ planType: 'plan500' }),
          })
          if (!exRes.ok) throw new Error(`兑换接口HTTP错误: ${exRes.status}`)
          const ex = await exRes.json()
          if (ex?.code !== 0) throw new Error(`${ex?.message || '兑换失败'} (code=${ex?.code})`)
          const remain = Number(ex?.points) || 0
          console.log(`[${tag}] ✅ 自动兑换成功，剩余积分: ${remain}`)
          notice.push(
            `【账号${accountNo}】自动兑换成功`,
            `兑换结果: ${ex?.message || '消耗500积分兑换100天'}`,
            `剩余积分: ${remain}`
          )
        } catch (exErr) {
          console.error(`[${tag}] ⚠️ 自动兑换异常（不影响签到结果）: ${exErr.message}`)
          notice.push(`【账号${accountNo}】自动兑换失败`, `错误: ${exErr.message}`)
        }
      } else if (autoExchange) {
        console.log(
          `[${tag}] 积分 ${currentPoints ?? '未知'} 未达到 ${exchangeThreshold}，本次不兑换`
        )
      } else {
        console.log(`[${tag}] 自动兑换已关闭`)
      }

      console.log(`[${tag}] ✅ ${alreadyCheckedIn ? '今日已签到过' : '签到成功'}`)
      console.log(`[${tag}] 返回消息: ${action?.message || ''}`)
      console.log(`[${tag}] 剩余天数: ${leftDays} 天`)
      console.log(`[${tag}] 当前积分: ${currentPoints != null ? currentPoints + ' 点' : '查询失败'}`)

      if (anomalies.length) {
        console.log(`[${tag}] ⚠️ 检出 ${anomalies.length} 项异常:`)
        anomalies.forEach((item) => console.log(`[${tag}]    · [${item.level}] ${item.text}`))
        criticalAnomalies += anomalies.filter((a) => a.level === 'critical').length
      }

      const summaryLines = [
        `【账号${accountNo}】签到成功`,
        `${alreadyCheckedIn ? '今日已签到过（无新增积分）' : action?.message}`,
        `剩余天数: ${leftDays} 天`,
        `当前积分: ${currentPoints != null ? currentPoints + ' 点' : '查询失败'}${bonusLine ? ' | ' + bonusLine : ''}`,
      ]
      if (anomalies.length) {
        summaryLines.push(`⚠️ 异常提示: ${anomalies.map((a) => a.text).join('；')}`)
      }
      notice.push(...summaryLines)
      successCount++
    } catch (error) {
      console.error(`[${tag}] ❌ 签到失败`)
      console.error(`[${tag}] 错误详情: ${error.message}`)

      notice.push(
        `【账号${accountNo}】签到失败`,
        `错误: ${error.message}`,
        `仓库地址: <${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
      )
      failCount++
    }
  }

  console.log('\n========== 各账号当前积分 ==========')
  if (pointsSummary.length) {
    pointsSummary.forEach((line) => console.log(`📊 ${line}`))
  } else {
    console.log('📊 无账号积分数据')
  }
  console.log('===================================')
  console.log('\n========== 签到任务处理完成 ==========')
  console.log(`📊 统计结果：成功 ${successCount} 个 | 失败 ${failCount} 个`)
  if (criticalAnomalies > 0) {
    console.error(`🚨 共检出 ${criticalAnomalies} 项严重异常，本次任务标记为失败`)
    process.exitCode = 1
  }
  return notice
}

// ========== 通知推送模块（保持原样） ==========
const notify = async (notice) => {
  console.log('\n========== 通知推送模块开始 ==========')
  if (!process.env.NOTIFY) {
    console.log('⚠️  未配置 NOTIFY 环境变量，跳过推送通知')
    return
  }
  if (!notice || notice.length === 0) {
    console.log('⚠️  无通知内容，跳过推送')
    return
  }
  const options = String(process.env.NOTIFY).split('\n').filter(Boolean)
  console.log(`📋 共配置 ${options.length} 个通知渠道`)
  for (const [idx, option] of options.entries()) {
    const channelNo = idx + 1
    let channelType = '默认(pushplus)'
    try {
      if (option.startsWith('console:')) {
        channelType = '控制台输出'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        console.log('———————— 通知内容 ————————')
        notice.forEach((line) => console.log(line))
        console.log('————————————————————————')
        console.log(`[通知 ${channelNo}] ✅ 控制台输出完成`)
      } else if (option.startsWith('wxpusher:')) {
        channelType = 'WxPusher'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        const parts = option.split(':')
        const appToken = parts[1]
        const uids = parts.slice(2)
        console.log(`[通知 ${channelNo}] appToken: ${mask(appToken)}`)
        console.log(`[通知 ${channelNo}] 推送UID数量: ${uids.length}`)
        const res = await fetch(`https://wxpusher.zjiecode.com/api/send/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appToken: appToken,
            summary: notice[0],
            content: notice.join('<br>'),
            contentType: 3,
            uids: uids,
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 1000) throw new Error(`${result.msg} (code=${result.code})`)
        console.log(`[通知 ${channelNo}] ✅ WxPusher 推送成功`)
      } else if (option.startsWith('pushplus:')) {
        channelType = 'PushPlus'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        const token = option.split(':')[1]
        console.log(`[通知 ${channelNo}] Token: ${mask(token)}`)
        const res = await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: token,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 200) throw new Error(`${result.msg} (code=${result.code})`)
        console.log(`[通知 ${channelNo}] ✅ PushPlus 推送成功`)
      } else if (option.startsWith('bark:')) {
        channelType = 'Bark'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        const barkKey = option.split(':')[1]
        console.log(`[通知 ${channelNo}] Bark密钥: ${mask(barkKey)}`)
        const res = await fetch(`https://api.day.app/${barkKey}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: notice[0],
            body: notice.slice(1).join('\n'),
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 200) throw new Error(`${result.message} (code=${result.code})`)
        console.log(`[通知 ${channelNo}] ✅ Bark 推送成功`)
      } else if (option.startsWith('qyweixin:')) {
        channelType = '企业微信Webhook'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        const qyToken = option.split(':')[1]
        console.log(`[通知 ${channelNo}] Webhook Key: ${mask(qyToken)}`)
        const qyweixinNotifyRebotUrl =
          'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + qyToken
        const res = await fetch(qyweixinNotifyRebotUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { content: notice.join('<br>') },
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.errcode !== 0) throw new Error(`${result.errmsg} (errcode=${result.errcode})`)
        console.log(`[通知 ${channelNo}] ✅ 企业微信推送成功`)
      } else {
        channelType = '默认PushPlus(兼容旧格式)'
        console.log(`\n[通知 ${channelNo}] 未识别渠道前缀，使用 ${channelType}`)
        console.log(`[通知 ${channelNo}] Token: ${mask(option)}`)
        const res = await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 200) throw new Error(`${result.msg} (code=${result.code})`)
        console.log(`[通知 ${channelNo}] ✅ PushPlus 推送成功`)
      }
    } catch (error) {
      console.error(`[通知 ${channelNo}] ❌ ${channelType} 推送失败`)
      console.error(`[通知 ${channelNo}] 错误详情: ${error.message}`)
    }
  }
  console.log('\n========== 通知推送模块结束 ==========')
}

// ========== 漏签核查（watchdog） ==========
// 为什么单独做这一层：
//   签到链路上任何一环无声失败，结果都是「今天没签到」而没有任何提示
//   （2026-11-13 就是 GitHub 直接丢掉了 schedule，job 没启动，自然没有通知）。
// 判定依据只认一件事：积分流水里有没有「今天」的记录。
//   不认 /api/user/status 的字段，也不认签到接口的 code——两者都出现过
//   「看起来成功、实际没有记一笔」的情况。
const fetchJson = async (url, headers) => {
  const res = await fetch(url, { method: 'GET', headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return res.json()
}

// 返回 { ok, recorded, leftDays, points, streak, error }
const inspectAccount = async (account, accountNo, domain) => {
  const tag = `[核查] 账号 ${accountNo}|${account.envName}`
  const headers = { ...buildBrowserHeaders(account.ua, domain), cookie: account.cookie }
  const out = { ok: false, recorded: null, leftDays: null, points: null, streak: null, error: null }
  try {
    const status = await fetchJson(`https://${domain}/api/user/status`, headers)
    if (status?.code !== 0) {
      throw new Error(`登录状态异常: ${status?.message || '未知错误'} (code=${status?.code})`)
    }
    out.leftDays = Number(status?.data?.leftDays)

    const pts = await fetchJson(`https://${domain}/api/user/points`, headers)
    if (pts?.code !== 0) {
      throw new Error(`积分接口异常: ${pts?.message || '未知错误'} (code=${pts?.code})`)
    }
    out.points = Number(pts?.points) || 0
    out.streak = Number(pts?.streak) || 0
    const history = pts?.history || pts?.list || []
    out.recorded = hasRecordToday(history)
    out.ok = true
    console.log(
      `${tag} 剩余 ${out.leftDays} 天 | 积分 ${out.points} | 连续 ${out.streak} 天 | ` +
        `今日流水: ${out.recorded === true ? '有' : out.recorded === false ? '无' : '无法解析'}`
    )
  } catch (err) {
    out.error = err.message
    console.error(`${tag} ❌ ${err.message}`)
  }
  return out
}

// 去重：本次核查有两条 cron（22:40 / 23:20）互相兜底，但正常情况下两条都会跑。
// 若前一条已经成功跑过并作出判断，后一条不再重复提醒，避免一天收到两条同样的消息。
const hasEarlierWatchdogRunToday = async () => {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (!token || !repo) return false
  try {
    const dayStart = `${todayBeijing()}T00:00:00+08:00`
    const q =
      `https://api.github.com/repos/${repo}/actions/workflows/` +
      `${process.env.WATCHDOG_WORKFLOW || 'watchdog.yml'}/runs` +
      `?created=${encodeURIComponent('>=' + dayStart)}&per_page=30`
    const res = await fetch(q, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'glados-watchdog',
      },
    })
    if (!res.ok) {
      console.log(`ℹ️  查询历史核查记录失败（HTTP ${res.status}），按「无历史记录」处理`)
      return false
    }
    const data = await res.json()
    const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : []
    const others = runs.filter(
      (r) => String(r.id) !== String(process.env.GITHUB_RUN_ID) && r.conclusion === 'success'
    )
    if (others.length) {
      console.log(
        `ℹ️  今天已有 ${others.length} 次核查成功执行（run ${others[others.length - 1].id}），本次不重复提醒`
      )
      return true
    }
    return false
  } catch (err) {
    console.log(`ℹ️  查询历史核查记录异常（${err.message}），按「无历史记录」处理`)
    return false
  }
}

const watchdog = async () => {
  console.log('========== 漏签核查开始 ==========')
  const domain = process.env.DOMAIN || 'glados.cloud'
  const accounts = collectAccounts()
  if (!accounts.length) {
    console.log('⚠️  未配置任何账号，核查跳过')
    return
  }
  const missing = [] // 确定没签的
  const unknown = [] // 判定不了或查询失败的
  const fine = []

  for (const [index, account] of accounts.entries()) {
    const accountNo = index + 1
    const r = await inspectAccount(account, accountNo, domain)
    const item = { accountNo, envName: account.envName, ...r }
    if (r.error) unknown.push(item)
    else if (r.recorded === false) missing.push(item)
    else if (r.recorded === null) unknown.push(item)
    else fine.push(item)
  }

  console.log(
    `\n📊 核查结果：已签到 ${fine.length} | 漏签 ${missing.length} | 无法判定 ${unknown.length}`
  )

  if (missing.length === 0 && unknown.length === 0) {
    console.log('✅ 全部账号今日已签到，无需提醒')
    return
  }

  // 只在「有问题」时推送：正常时保持静默，避免每天多一条噪声消息
  if (await hasEarlierWatchdogRunToday()) {
    console.log('ℹ️  本次为当日重复核查，跳过提醒（问题已由前一次核查报出）')
    if (missing.length) process.exitCode = 1
    return
  }

  const now = new Date(Date.now() + BEIJING_OFFSET_MS).toISOString()
  const stamp = `${now.slice(0, 10)} ${now.slice(11, 16)}`
  const notice = [
    missing.length
      ? `🚨 GLaDOS 漏签提醒（${missing.length} 个账号未签）`
      : '⚠️ GLaDOS 签到状态无法确认',
    `核查时间: ${stamp}（北京时间）`,
  ]

  for (const it of missing) {
    notice.push(
      `账号${it.accountNo}(${it.envName}): **今日无签到记录** | 剩余 ${it.leftDays ?? '?'} 天 | ` +
        `积分 ${it.points ?? '?'} | 连续 ${it.streak ?? '?'} 天`
    )
  }
  for (const it of unknown) {
    notice.push(
      `账号${it.accountNo}(${it.envName}): 无法判定${it.error ? `（${it.error}）` : '（流水结构异常）'}`
    )
  }
  notice.push('请到网页端手动签到一次，避免连续天数中断：https://glados.cloud/console/checkin')
  if (process.env.GITHUB_RUN_ID) {
    notice.push(`运行详情: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`)
  }

  const dryRun = String(process.env.WATCHDOG_DRY_RUN || '').toLowerCase() === 'true'
  if (dryRun) {
    console.log('🧪 DRY RUN：以下内容仅打印，不实际推送')
    console.log('———————— 通知内容 ————————')
    notice.forEach((l) => console.log('  ' + l))
    console.log('————————————————————————')
    if (missing.length) process.exitCode = 1
    return
  }

  await notify(notice)
  // 用非零退出码把这次运行标红，让「漏签」在 Actions 里也一眼可见
  if (missing.length) process.exitCode = 1
}

// ========== 主入口 ==========
const main = async () => {
  await waitForWindow()
  const notice = await glados()
  await notify(notice)
  console.log('\n🎉 全部任务执行完毕')
}

const isWatchdog = process.argv.includes('--watchdog')

if (isWatchdog) {
  watchdog().catch((err) => {
    console.error('❌ 核查任务未捕获错误:', err)
    process.exit(1)
  })
} else {
  main().catch((err) => {
    console.error('❌ 全局未捕获错误:', err)
    process.exit(1)
  })
}
