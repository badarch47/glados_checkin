const glados = async () => {
  const notice = [];
  if (!process.env.GLADOS) {
    console.error("❌ 错误: 未检测到 GLADOS Cookie 配置");
    notice.push("❌ 未检测到 GLADOS Cookie 配置");
    return notice;
  }

  const cookies = String(process.env.GLADOS)
    .split(/&|\n/)
    .filter((c) => c.trim());

  if (cookies.length === 0) {
    console.error("❌ 错误: GLADOS Cookie 格式不正确或为空");
    notice.push("❌ 未检测到有效 GLADOS Cookie");
    return notice;
  }

  console.log(`🚀 开始处理 ${cookies.length} 个账号...\n`);

  let ok = 0, fail = 0, repeat = 0;
  const detailLines = [];

  for (const [idx, cookie] of cookies.entries()) {
    const cookieTrim = cookie.trim();
    if (!cookieTrim) continue;

    let email = "unknown";
    let points = "-";
    let days = "-";
    let status = "";
    let msg = "";

    console.log(`[账号 ${idx + 1}] ------------------------------`);

    try {
      const commonHeaders = {
        "cookie": cookieTrim,
        "referer": "https://glados.cloud/console/checkin",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "content-type": "application/json;charset=UTF-8",
        "origin": "https://glados.cloud"
      };

      // 1. 先查询账号状态 (登录检查)
      try {
        const statusRes = await fetch("https://glados.cloud/api/user/status", {
          method: "GET",
          headers: commonHeaders,
        });
        const statusData = await statusRes.json();
        if (statusData.code === 0) {
          email = statusData.data.email || "未知";
          days = `${Math.floor(Number(statusData.data.leftDays))} 天`;
          console.log(`✅ 登录成功: ${email} (剩余 ${days})`);
        } else {
          console.log(`⚠️ 登录状态异常: ${statusData.message || 'Cookie 可能已失效'}`);
        }
      } catch (e) {
        console.log(`⚠️ 账号状态查询失败 (不影响签到)`);
      }

      // 2. 执行签到请求
      console.log(`正在尝试签到...`);
      const checkinRes = await fetch("https://glados.cloud/api/user/checkin", {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ token: "glados.cloud" }),
      });
      
      const checkinData = await checkinRes.json();
      msg = checkinData.message || "未知响应";
      console.log(`结果: ${msg}`);

      // 3. 判断签到结果
      if (msg.toLowerCase().includes("got")) {
        ok += 1;
        status = "✅ 成功";
        points = checkinData.points || "-";
      } else if (msg.toLowerCase().includes("repeat") || msg.toLowerCase().includes("already")) {
        repeat += 1;
        status = "🔁 已签到";
      } else {
        fail += 1;
        status = "❌ 失败";
      }

      detailLines.push(`${idx + 1}. ${email} | ${status} | 积分:${points} | 剩余:${days}`);
      
      // 随机延迟防止风控
      if (idx < cookies.length - 1) {
        const delay = Math.floor(Math.random() * 2000 + 1000);
        console.log(`等待 ${delay}ms 后处理下一个账号...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

    } catch (error) {
      fail += 1;
      status = "❌ 异常";
      console.error(`❌ 运行异常: ${error.message}`);
      detailLines.push(`${idx + 1}. [未知账号] | ${status} | 原因:${error.message}`);
    }
  }

  // 组装总结
  const summary = `GLaDOS 签到完成 ✅${ok} ❌${fail} 🔁${repeat}`;
  notice.push(summary);
  notice.push(...detailLines);
  
  console.log(`\n==========================================`);
  console.log(summary);
  console.log(detailLines.join('\n'));
  console.log(`==========================================\n`);

  return notice;
};

const notify = async (notice) => {
  if (!process.env.NOTIFY || !notice || notice.length === 0) {
    console.log("ℹ️ 未配置推送通知环境变量，跳过推送。");
    return;
  }

  for (const option of String(process.env.NOTIFY).split('\n')) {
    if (!option) continue;
    try {
      if (option.startsWith('console:')) {
        // 已经在 glados 函数里打印过了，此处跳过
      } else if (option.startsWith('wxpusher:')) {
        await fetch(`https://wxpusher.zjiecode.com/api/send/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appToken: option.split(':')[1],
            summary: notice[0],
            content: notice.join('<br>'),
            contentType: 3,
            uids: option.split(':').slice(2),
          }),
        });
        console.log("🚀 WxPusher 推送成功");
      } else if (option.startsWith('qyweixin:')) {
        const qyweixinToken = option.split(':')[1];
        await fetch(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${qyweixinToken}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
                // 企业微信 Markdown 换行建议使用 \n
                content: notice.join('\n\n') 
            }
          }),
        });
        console.log("🚀 企业微信机器人推送成功");
      } else if (option.startsWith('pushplus:')) {
        const token = option.split(':')[1];
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: token,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        });
        console.log("🚀 PushPlus 推送成功");
      }
    } catch (error) {
      console.error('❌ 推送失败:', error.message);
    }
  }
};

const main = async () => {
  try {
    const results = await glados();
    await notify(results);
  } catch (err) {
    console.error("程序崩溃:", err);
  }
};

main();
