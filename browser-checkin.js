// 浏览器通道：用真实 Chromium 过 Cloudflare Turnstile 后完成签到
// ---------------------------------------------------------------------------
// 为什么需要它：
//   2026-11-14 起 /api/user/checkin 增加 Turnstile 校验，纯 HTTP 请求返回
//   code=5 / reason=turnstile。令牌由 Cloudflare 在浏览器里执行 JS 后签发，
//   Node 侧无法伪造，只能真的跑一个浏览器。
//
// 协议（逆向自 glados.cloud 前端 main~21b3c6c3.chunk.js）：
//   1) GET  /api/user/checkin/challenge -> { code, nonce, ttl, turnstile:<sitekey> }
//   2) renderTurnstile(box, sitekey, cb, {
//        action: 'checkin',          // 站点固定值
//        cData: nonce,               // 关键：绑定到本次 nonce，缺了会报 600010
//        appearance: 'interaction-only',
//      })
//   3) 等令牌：非交互 15s，需交互 90s；超时后仍会提交，但 tsState 记为 timeout
//   4) nonce 签发后必须 >= 2500ms 才提交（前端硬性下限）
//   5) proof = SHA256_HEX(nonce + '.glados-observe-v1')
//   6) POST /api/user/checkin
//      body: { token: <hostname>, nonce, proof, tsState, turnstile? }
//
// 本模块把 2~6 全部放在页面上下文里执行，好处是：请求自带正确 Origin、
// Referer、Cookie 和浏览器指纹，不需要在 Node 侧手工拼请求头。

const PROOF_SALT = 'glados-observe-v1'

// Cookie 字符串 -> Playwright addCookies 需要的结构
const parseCookiePairs = (raw) =>
  String(raw || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf('=')
      if (i <= 0) return null
      return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim() }
    })
    .filter(Boolean)

export const browserAvailable = async () => {
  try {
    await import('playwright')
    return true
  } catch {
    return false
  }
}

/**
 * @returns {Promise<object>} 与 HTTP 签到接口一致的响应体
 */
export const browserCheckin = async ({
  domain,
  cookie,
  ua,
  headless = true,
  interactive = false,
  tokenTimeoutMs = 95000,
  logger = console,
}) => {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    throw new Error(
      '未安装 playwright，浏览器通道不可用。请在 workflow 里执行 ' +
        '`npm i playwright --no-save && npx playwright install --with-deps chromium`'
    )
  }

  const log = (msg) => logger.log(`  [浏览器] ${msg}`)
  const pairs = parseCookiePairs(cookie)
  if (!pairs.length) throw new Error('Cookie 解析为空，无法注入浏览器会话')

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
  ]
  const launchOpts = {
    headless,
    ignoreDefaultArgs: ['--enable-automation'],
    args: launchArgs,
  }
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  }

  log(`启动 Chromium（${headless ? 'headless' : 'headed'}）`)
  const browser = await chromium.launch(launchOpts)
  let result
  try {
    const context = await browser.newContext({
      userAgent: ua,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1280, height: 800 },
    })
    // 抹掉最明显的自动化痕迹（navigator.webdriver）
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      } catch {}
    })

    await context.addCookies(
      pairs.map((c) => ({ name: c.name, value: c.value, domain: `.${domain}`, path: '/' }))
    )
    log(`已注入 ${pairs.length} 个 Cookie 字段: ${pairs.map((c) => c.name).join('、')}`)

    const page = await context.newPage()
    page.setDefaultTimeout(60000)

    // 用签到页而不是首页：站内路由与安全策略都与真实用户一致
    const entry = `https://${domain}/console/checkin`
    log(`打开 ${entry}`)
    await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 60000 })

    // 第一步：取挑战 + 渲染 widget（cData 必须是服务端签发的 nonce）
    const prepared = await page.evaluate(async ({ salt }) => {
      const w = (window.__gl = { nonce: null, sitekey: null, token: null, state: 'none', events: [] })
      const res = await fetch('/api/user/checkin/challenge', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      const ch = await res.json()
      if (ch?.code !== 0 || !ch?.nonce) return { ok: false, stage: 'challenge', body: ch }
      w.nonce = ch.nonce
      w.at = Date.now() // 提交时必须满足 nonce 年龄 >= 2500ms
      w.sitekey = ch.turnstile || null
      if (!w.sitekey) {
        // 服务端不再要求 Turnstile，交给 HTTP 通道即可
        w.state = 'off'
        return { ok: true, nonce: ch.nonce, sitekey: null, salt }
      }

      await new Promise((resolve, reject) => {
        if (window.turnstile) return resolve()
        const s = document.createElement('script')
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
        s.async = true
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('turnstile script load failed'))
        document.head.appendChild(s)
      })

      const box = document.createElement('div')
      box.id = '__gl_ts'
      box.style.cssText =
        'position:fixed;left:40px;top:120px;width:300px;height:70px;z-index:2147483647;background:#fff'
      document.body.appendChild(box)

      window.turnstile.render(box, {
        sitekey: w.sitekey,
        theme: 'light',
        action: 'checkin',
        cData: ch.nonce,
        appearance: 'interaction-only',
        callback: (t) => {
          w.token = t
          w.state = 'ok'
        },
        'error-callback': (e) => {
          w.state = 'error'
          w.events.push('err:' + e)
        },
        'expired-callback': () => {
          w.token = null
          w.state = 'expired'
        },
        'before-interactive-callback': () => {
          w.state = 'interactive'
          w.events.push('interactive')
        },
      })
      return { ok: true, nonce: ch.nonce, sitekey: w.sitekey, salt }
    }, { salt: PROOF_SALT })

    if (!prepared?.ok) {
      const b = prepared?.body || {}
      log(`取挑战失败: code=${b.code} ${b.message || ''}`)
      return b
    }
    log(`挑战已获取 nonce=${String(prepared.nonce).slice(0, 6)}… sitekey=${prepared.sitekey || '无'}`)

    // 第二步：等待 Turnstile 令牌
    let state = 'none'
    if (prepared.sitekey) {
      const deadline = Date.now() + tokenTimeoutMs
      let clicked = false
      while (Date.now() < deadline) {
        const s = await page.evaluate(() => ({
          state: window.__gl.state,
          hasToken: !!window.__gl.token,
          events: window.__gl.events,
        }))
        state = s.hasToken ? 'ok' : s.state
        if (s.hasToken) break
        if (s.state === 'error' || s.state === 'expired') break
        // 需要人工交互时，尝试点击复选框：widget 渲染在固定坐标，
        // 内部 iframe 处于 closed shadow root，只能按坐标点。
        if (interactive && s.state === 'interactive' && !clicked) {
          clicked = true
          log('widget 要求交互，尝试点击复选框')
          // widget 的内部 iframe 位于 closed shadow root，拿不到句柄，只能按坐标点；
          // 同时尝试直接点 frame 内的复选框（Playwright 可以跨 frame 操作）。
          const frame = page.frames().find((f) => /challenges\.cloudflare\.com/.test(f.url()))
          if (frame) {
            await frame
              .click('input[type="checkbox"], .cb-lb, #challenge-stage', { force: true, timeout: 2000 })
              .catch(() => {})
            await page.waitForTimeout(1500)
          }
          for (const [dx, dy] of [[30, 34], [24, 32], [36, 36]]) {
            if (await page.evaluate(() => !!window.__gl.token)) break
            await page.mouse.move(40 + dx - 10, 120 + dy - 12, { steps: 6 })
            await page.waitForTimeout(200)
            await page.mouse.down()
            await page.waitForTimeout(80)
            await page.mouse.up()
            await page.waitForTimeout(1500)
          }
        }
        await page.waitForTimeout(500)
      }
      log(`Turnstile 结果: ${state}${state === 'ok' ? '（已取得令牌）' : ''}`)
      if (state !== 'ok') {
        const ev = await page.evaluate(() => window.__gl.events)
        log(`未取得令牌，事件: ${ev.join(',') || '无'}；仍提交一次交由服务端判定`)
      }
    }

    // 第三步：计算 proof 并提交（nonce 签发后至少 2500ms）
    const submitted = await page.evaluate(async ({ salt, host }) => {
      const w = window.__gl
      const age = Date.now() - (w.at || 0)
      if (age < 2500) await new Promise((r) => setTimeout(r, 2500 - age))
      const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${w.nonce}.${salt}`)
      )
      const proof = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
      const payload = { token: host, nonce: w.nonce, proof, tsState: w.token ? 'ok' : w.state }
      if (w.token) payload.turnstile = w.token
      const res = await fetch('/api/user/checkin', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: res.status, body: await res.json() }
    }, { salt: PROOF_SALT, host: domain })

    // 记录挑战签发时间，供上面 2500ms 判定使用（放在提交前赋值）
    result = submitted.body
    log(`签到响应: HTTP ${submitted.status} code=${result?.code ?? '无'} ${result?.message || ''}`)
    return result
  } finally {
    await browser.close().catch(() => {})
  }
}
