export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("WebDAV Multi Bot is Running ✅");
    const update = await request.json();
    console.log("UPDATE:", JSON.stringify(update));

    const msg = update.message;
    if (!msg) return new Response("OK");

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text?.trim() || "";

    let config = await env.USERS.get(`config:${userId}`, { type: "json" });
    let state = await env.USERS.get(`state:${userId}`, { type: "json" });
    console.log(`User ${userId} text=${text} state=${JSON.stringify(state)} config=${JSON.stringify(config)}`);

    try {
      if (text === "/start") {
        await env.USERS.delete(`state:${userId}`);
        await sendMessage(env.BOT_TOKEN, chatId, "سلام 👋\n\n🔑 /login - ورود\n📂 /list - لیست\n📂 /list public_html - پوشه خاص\n📥 /get نام فایل - دانلود\n🗑 /del نام فایل - حذف\n📁 /mkdir نام پوشه\n🐛 /debug - تست اتصال\n👤 /account\n🚪 /logout");
        return new Response("OK");
      }

      if (text === "/logout") {
        await env.USERS.delete(`config:${userId}`);
        await env.USERS.delete(`state:${userId}`);
        await sendMessage(env.BOT_TOKEN, chatId, "🚪 خارج شدی. /login بزن");
        return new Response("OK");
      }

      if (text === "/account") {
        if (!config) await sendMessage(env.BOT_TOKEN, chatId, "❌ وارد نشدی. /login بزن");
        else await sendMessage(env.BOT_TOKEN, chatId, `👤 اکانت:\n🌐 ${config.url}\n👤 ${config.user}`);
        return new Response("OK");
      }

      if (text === "/login") {
        await env.USERS.put(`state:${userId}`, JSON.stringify({ step: "wait_url" }));
        await sendMessage(env.BOT_TOKEN, chatId, "🌐 آدرس WebDAV رو بفرست:\nمثال: https://yourdomain.com:2078");
        return new Response("OK");
      }

      // مراحل لاگین - فقط اگر دستور نباشد
      if (state?.step === "wait_url" && text.startsWith("http") && !text.startsWith("/")) {
        state = { step: "wait_user", url: text.replace(/\/$/, "") };
        await env.USERS.put(`state:${userId}`, JSON.stringify(state));
        await sendMessage(env.BOT_TOKEN, chatId, "👤 یوزرنیم WebDAV رو بفرست:");
        return new Response("OK");
      }

      if (state?.step === "wait_user" && !text.startsWith("/")) {
        state = { step: "wait_pass", url: state.url, user: text };
        await env.USERS.put(`state:${userId}`, JSON.stringify(state));
        await sendMessage(env.BOT_TOKEN, chatId, "🔒 پسورد WebDAV رو بفرست:");
        return new Response("OK");
      }

      if (state?.step === "wait_pass" && !text.startsWith("/")) {
        const newConfig = { url: state.url, user: state.user, pass: text };
        await sendMessage(env.BOT_TOKEN, chatId, "⏳ در حال تست اتصال...");
        try {
          await webdavList(newConfig, "");
          await env.USERS.put(`config:${userId}`, JSON.stringify(newConfig));
          await env.USERS.delete(`state:${userId}`);
          await sendMessage(env.BOT_TOKEN, chatId, `✅ وصل شدی!\n📂 ${newConfig.url}\n/list رو بزن`);
        } catch (e) {
          console.log("LOGIN FAILED:", e.message);
          await sendMessage(env.BOT_TOKEN, chatId, `❌ اتصال ناموفق: ${e.message}\nدوباره /login بزن`);
          await env.USERS.delete(`state:${userId}`);
        }
        return new Response("OK");
      }

      // اگر state گیر کرده و کاربر دستور زد، state رو پاک کن
      if (state && text.startsWith("/")) {
        await env.USERS.delete(`state:${userId}`);
        state = null;
      }

      if (!config) {
        await sendMessage(env.BOT_TOKEN, chatId, "⛔ اول /login بزن");
        return new Response("OK");
      }

      // دستورات بعد از لاگین
      if (text === "/debug") {
        const base = config.url.replace(/\/$/, "") + "/";
        console.log("DEBUG URL:", base);
        const res = await fetch(base, {
          method: "PROPFIND",
          headers: { "Authorization": getAuth(config), "Depth": "1", "Content-Type": "application/xml" },
          body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`
        });
        const raw = await res.text();
        console.log("DEBUG RES:", res.status, raw.slice(0, 1500));
        await sendMessage(env.BOT_TOKEN, chatId, `Status: ${res.status}\nURL: ${base}\n\n${raw.slice(0, 3500) || "(خالی)"}`);
        return new Response("OK");
      }

      if (text.startsWith("/list")) {
        const path = text.replace("/list", "").trim();
        console.log("LIST path:", path);
        const list = await webdavList(config, path);
        await sendMessage(env.BOT_TOKEN, chatId, `📂 لیست:\n\n${list}`);
      } else if (text.startsWith("/del ")) {
        const file = text.replace("/del ", "").trim();
        await webdavDelete(config, file);
        await sendMessage(env.BOT_TOKEN, chatId, `✅ حذف شد: ${file}`);
      } else if (text.startsWith("/mkdir ")) {
        const dir = text.replace("/mkdir ", "").trim();
        await webdavMkdir(config, dir);
        await sendMessage(env.BOT_TOKEN, chatId, `✅ ساخته شد: ${dir}`);
      } else if (text.startsWith("/get ")) {
        const file = text.replace("/get ", "").trim();
        await sendMessage(env.BOT_TOKEN, chatId, `⏳ دانلود ${file}...`);
        const data = await webdavDownload(config, file);
        await sendDocument(env.BOT_TOKEN, chatId, data, file.split('/').pop());
      } else if (msg.document) {
        await sendMessage(env.BOT_TOKEN, chatId, "⏳ آپلود...");
        const fileUrl = await getTelegramFileUrl(env.BOT_TOKEN, msg.document.file_id);
        const buffer = await fetch(fileUrl).then(r => r.arrayBuffer());
        await webdavUpload(config, msg.document.file_name, buffer);
        await sendMessage(env.BOT_TOKEN, chatId, `✅ آپلود شد: ${msg.document.file_name}`);
      } else if (text.startsWith("/")) {
        await sendMessage(env.BOT_TOKEN, chatId, "دستور نامعتبر. /start رو بزن");
      }

    } catch (e) {
      console.log("ERROR:", e.message, e.stack);
      await sendMessage(env.BOT_TOKEN, chatId, `❌ خطا: ${e.message}`);
    }
    return new Response("OK");
  }
}

// ===== توابع WebDAV - فیکس شده برای cPanel =====
function getAuth(config) {
  return "Basic " + btoa(`${config.user}:${config.pass}`);
}

async function webdavList(config, path = "") {
  const base = config.url.replace(/\/$/, "");
  const url = path ? `${base}/${path.replace(/^\//, "")}` : base + "/";
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: {
      "Authorization": getAuth(config),
      "Depth": "1",
      "Content-Type": "application/xml"
    },
    body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>`
  });
  if (res.status !== 207 && !res.ok) throw new Error(`WebDAV Error ${res.status}`);
  const text = await res.text();
  if (text.length < 20) throw new Error("پاسخ خالی از سرور - /debug رو بزن");
  const matches = [...text.matchAll(/<[^>]*href[^>]*>(.*?)<\/[^>]*href>/gi)];
  let files = matches.map(m => {
    try { return decodeURIComponent(m[1]); } catch(e){ return m[1]; }
  });
  const basePath = new URL(url).pathname;
  files = files.filter(href => {
    try {
      const p = new URL(href, url).pathname;
      return p !== basePath && p !== basePath.replace(/\/$/, "") && p !== basePath + "/";
    } catch(e){ return true; }
  }).map(href => {
    const clean = href.split('?')[0].split('#')[0];
    const name = decodeURIComponent(clean.split('/').filter(Boolean).pop() || "");
    if (!name) return null;
    const isDir = href.endsWith('/');
    return (isDir ? "📁 " : "📄 ") + name + (isDir ? "/" : "");
  }).filter(Boolean);
  const unique = [...new Set(files)];
  if (unique.length === 0) throw new Error("پوشه خالی به نظر میرسه - /debug رو بزن");
  return unique.join("\n");
}

async function webdavUpload(config, filename, buffer) {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/${filename}`, {
    method: "PUT",
    headers: { "Authorization": getAuth(config) },
    body: buffer
  });
  if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error(`Upload failed ${res.status}`);
}

async function webdavDownload(config, filename) {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/${filename}`, {
    headers: { "Authorization": getAuth(config) }
  });
  if (!res.ok) throw new Error(`File not found ${res.status}`);
  return await res.arrayBuffer();
}

async function webdavDelete(config, filename) {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/${filename}`, {
    method: "DELETE",
    headers: { "Authorization": getAuth(config) }
  });
  if (!res.ok && res.status !== 204) throw new Error(`Delete failed ${res.status}`);
}

async function webdavMkdir(config, dirname) {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/${dirname}`, {
    method: "MKCOL",
    headers: { "Authorization": getAuth(config) }
  });
  if (!res.ok && res.status !== 201 && res.status !== 405) throw new Error(`Mkdir failed ${res.status}`);
}

async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function sendDocument(token, chatId, data, filename) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", new Blob([data]), filename);
  await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
}

async function getTelegramFileUrl(token, fileId) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`).then(r => r.json());
  return `https://api.telegram.org/file/bot${token}/${res.result.file_path}`;
}
