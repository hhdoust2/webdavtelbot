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
    const caption = msg.caption?.trim() || "";

    let config = await env.USERS.get(`config:${userId}`, { type: "json" });
    let state = await env.USERS.get(`state:${userId}`, { type: "json" });

    try {
      if (text === "/start") {
        await env.USERS.delete(`state:${userId}`);
        await sendMessage(env.BOT_TOKEN, chatId, "سلام 👋 کدخدا\n\n🔑 /login - ورود\n📂 /list - لیست روت\n📂 /list data - لیست پوشه\n📤 /upload - آپلود فایل\n📤 /upload data/ - آپلود داخل پوشه\n📥 /get bot.js - دانلود\n🗑 /del file.txt - حذف\n📁 /mkdir test - ساخت پوشه\n🐛 /debug - تست اتصال\n👤 /account\n🚪 /logout\n\nبرای آپلود: /upload بزن بعد فایل رو بفرست");
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
          await sendMessage(env.BOT_TOKEN, chatId, `❌ اتصال ناموفق: ${e.message}\nدوباره /login بزن`);
          await env.USERS.delete(`state:${userId}`);
        }
        return new Response("OK");
      }

      // اگر دستور جدید زد state قبلی پاک شه
      if (state && text.startsWith("/") && !text.startsWith("/upload")) {
        if (state.step === "wait_upload") {
          // اجازه بده /upload جدید جایگزین شه
        } else {
          await env.USERS.delete(`state:${userId}`);
          state = null;
        }
      }

      if (!config) {
        // اجازه بده لاگین انجام شه
        if (state?.step) return new Response("OK");
        await sendMessage(env.BOT_TOKEN, chatId, "⛔ اول /login بزن");
        return new Response("OK");
      }

      // ===== کامند جدید /upload =====
      if (text === "/upload" || text.startsWith("/upload ")) {
        let target = text.replace("/upload", "").trim();
        // اگر /upload خالی بود یعنی روت
        if (!target) target = "";
        // اگر پوشه بود / آخر اضافه کن
        if (target && !target.endsWith("/")) {
          // اگر نقطه داشت یعنی فایل نیست، پوشه است
          if (!target.includes(".")) target += "/";
        }
        await env.USERS.put(`state:${userId}`, JSON.stringify({ step: "wait_upload", target }));
        if (target) await sendMessage(env.BOT_TOKEN, chatId, `📤 آماده آپلود داخل پوشه: ${target}\nحالا فایل رو به صورت Document بفرست\n(یا فایل رو بفرست و کپشن رو بذار ${target})`);
        else await sendMessage(env.BOT_TOKEN, chatId, `📤 آماده آپلود در روت اصلی\nحالا فایل رو به صورت Document بفرست\nنکته: میتونی فایل رو بفرستی و کپشن رو بذاری مثلا data/ تا بره داخل پوشه`);
        return new Response("OK");
      }

      if (text === "/debug") {
        const base = config.url.replace(/\/$/, "") + "/";
        const res = await fetch(base, {
          method: "PROPFIND",
          headers: { "Authorization": getAuth(config), "Depth": "1", "Content-Type": "application/xml" },
          body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`
        });
        const raw = await res.text();
        await sendMessage(env.BOT_TOKEN, chatId, `Status: ${res.status}\nURL: ${base}\n\n${raw.slice(0, 3500) || "(خالی)"}`);
        return new Response("OK");
      }

      if (text.startsWith("/list")) {
        const path = text.replace("/list", "").trim();
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
        // ===== منطق آپلود با کامند =====
        let targetFolder = "";
        // 1. اگر با /upload اومده
        if (state?.step === "wait_upload") {
          targetFolder = state.target || "";
          await env.USERS.delete(`state:${userId}`);
        }
        // 2. اگر کپشن داره (اولویت با کپشن)
        if (caption) {
          targetFolder = caption.trim();
          if (targetFolder && !targetFolder.endsWith("/")) {
            if (!targetFolder.includes(".") || targetFolder.endsWith("/")) targetFolder += "/";
            else {
              // کپشن شامل نام فایل هم هست
            }
          }
        }
        // ساخت نام نهایی
        let filename = msg.document.file_name;
        let finalPath = targetFolder ? `${targetFolder.replace(/^\//, "")}${filename}` : filename;
        // اگر کپشن خودش شامل / بود و اسم فایل داشت
        if (caption && caption.includes(".")) {
          finalPath = caption.replace(/^\//, "");
        }

        await sendMessage(env.BOT_TOKEN, chatId, `⏳ در حال آپلود ${finalPath}...`);
        const fileUrl = await getTelegramFileUrl(env.BOT_TOKEN, msg.document.file_id);
        const buffer = await fetch(fileUrl).then(r => r.arrayBuffer());
        await webdavUpload(config, finalPath, buffer);
        await sendMessage(env.BOT_TOKEN, chatId, `✅ آپلود شد: ${finalPath}`);
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

function getAuth(config) { return "Basic " + btoa(`${config.user}:${config.pass}`); }

async function webdavList(config, path = "") {
  const base = config.url.replace(/\/$/, "");
  const url = path ? `${base}/${path.replace(/^\//, "")}` : base + "/";
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: { "Authorization": getAuth(config), "Depth": "1", "Content-Type": "application/xml" },
    body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>`
  });
  if (res.status !== 207 && !res.ok) throw new Error(`WebDAV Error ${res.status}`);
  const text = await res.text();
  if (text.length < 20) throw new Error("پاسخ خالی از سرور - /debug رو بزن");
  const matches = [...text.matchAll(/<[^>]*href[^>]*>(.*?)<\/[^>]*href>/gi)];
  let files = matches.map(m => { try { return decodeURIComponent(m[1]); } catch(e){ return m[1]; } });
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
  const res = await fetch(`${config.url.replace(/\/$/, "")}/${filename}`, { headers: { "Authorization": getAuth(config) } });
  if (!res.ok) throw new Error(`File not found ${res.status}`);
  return await res.arrayBuffer();
}

async function webdavDelete(config, filename) {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/${filename}`, { method: "DELETE", headers: { "Authorization": getAuth(config) } });
  if (!res.ok && res.status !== 204) throw new Error(`Delete failed ${res.status}`);
}

async function webdavMkdir(config, dirname) {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/${dirname}`, { method: "MKCOL", headers: { "Authorization": getAuth(config) } });
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
