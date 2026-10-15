export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("WebDAV Multi Bot is Running ✅");

    const update = await request.json();
    const msg = update.message;
    if (!msg) return new Response("OK");

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text?.trim() || "";

    // گرفتن اطلاعات کاربر و وضعیت
    let config = await env.USERS.get(`config:${userId}`, { type: "json" });
    let state = await env.USERS.get(`state:${userId}`, { type: "json" });

    try {
      // /start
      if (text === "/start") {
        await sendMessage(env.BOT_TOKEN, chatId,
          `سلام 👋 به ربات WebDAV مولتی خوش اومدی\n\n` +
          `🔑 /login - ورود به هاست خودت\n` +
          `📂 /list - لیست فایل ها\n` +
          `📥 /get نام فایل - دانلود\n` +
          `🗑 /del نام فایل - حذف\n` +
          `📁 /mkdir نام پوشه - ساخت پوشه\n` +
          `👤 /account - اطلاعات اکانت\n` +
          `🚪 /logout - خروج\n\n` +
          `📎 برای آپلود کافیه فایل رو به ربات بفرستی`
        );
        return new Response("OK");
      }

      // /login - شروع مراحل ورود
      if (text === "/login") {
        await env.USERS.put(`state:${userId}`, JSON.stringify({ step: "wait_url" }));
        await sendMessage(env.BOT_TOKEN, chatId, "🌐 آدرس WebDAV خودت رو بفرست:\nمثال: `https://yourdomain.com:2078` یا `https://webdav.hetzner.com`");
        return new Response("OK");
      }

      // مراحل ورود قدم به قدم
      if (state?.step === "wait_url" && text.startsWith("http")) {
        state = { step: "wait_user", url: text.replace(/\/$/, "") };
        await env.USERS.put(`state:${userId}`, JSON.stringify(state));
        await sendMessage(env.BOT_TOKEN, chatId, "👤 حالا یوزرنیم WebDAV رو بفرست:");
        return new Response("OK");
      }

      if (state?.step === "wait_user") {
        state = { step: "wait_pass", url: state.url, user: text };
        await env.USERS.put(`state:${userId}`, JSON.stringify(state));
        await sendMessage(env.BOT_TOKEN, chatId, "🔒 حالا پسورد WebDAV رو بفرست:");
        return new Response("OK");
      }

      if (state?.step === "wait_pass") {
        const newConfig = { url: state.url, user: state.user, pass: text };
        // تست اتصال
        await sendMessage(env.BOT_TOKEN, chatId, "⏳ در حال تست اتصال...");
        try {
          await webdavList(newConfig);
          await env.USERS.put(`config:${userId}`, JSON.stringify(newConfig));
          await env.USERS.delete(`state:${userId}`);
          await sendMessage(env.BOT_TOKEN, chatId, `✅ با موفقیت وصل شدی!\n📂 ${newConfig.url}\n حالا /list رو بزن`);
        } catch (e) {
          await sendMessage(env.BOT_TOKEN, chatId, `❌ اتصال ناموفق: ${e.message}\nدوباره /login بزن`);
        }
        return new Response("OK");
      }

      // /logout
      if (text === "/logout") {
        await env.USERS.delete(`config:${userId}`);
        await env.USERS.delete(`state:${userId}`);
        await sendMessage(env.BOT_TOKEN, chatId, "🚪 از اکانت خارج شدی. برای ورود دوباره /login");
        return new Response("OK");
      }

      // /account
      if (text === "/account") {
        if (!config) await sendMessage(env.BOT_TOKEN, chatId, "❌ هنوز وارد نشدی. /login رو بزن");
        else await sendMessage(env.BOT_TOKEN, chatId, `👤 اکانت شما:\n🌐 ${config.url}\n👤 ${config.user}`);
        return new Response("OK");
      }

      // از اینجا به بعد نیاز به لاگین داره
      if (!config) {
        await sendMessage(env.BOT_TOKEN, chatId, "⛔ اول باید وارد بشی. دستور /login رو بزن");
        return new Response("OK");
      }

      // /list
      if (text.startsWith("/list")) {
        const path = text.replace("/list", "").trim();
        const list = await webdavList(config, path);
        await sendMessage(env.BOT_TOKEN, chatId, `📂 لیست فایل ها:\n\n${list}`);
      }
      // /del
      else if (text.startsWith("/del ")) {
        const file = text.replace("/del ", "").trim();
        await webdavDelete(config, file);
        await sendMessage(env.BOT_TOKEN, chatId, `✅ حذف شد: ${file}`);
      }
      // /mkdir
      else if (text.startsWith("/mkdir ")) {
        const dir = text.replace("/mkdir ", "").trim();
        await webdavMkdir(config, dir);
        await sendMessage(env.BOT_TOKEN, chatId, `✅ پوشه ساخته شد: ${dir}`);
      }
      // /get
      else if (text.startsWith("/get ")) {
        const file = text.replace("/get ", "").trim();
        await sendMessage(env.BOT_TOKEN, chatId, `⏳ در حال دانلود ${file}...`);
        const data = await webdavDownload(config, file);
        await sendDocument(env.BOT_TOKEN, chatId, data, file.split('/').pop());
      }
      // آپلود فایل
      else if (msg.document) {
        await sendMessage(env.BOT_TOKEN, chatId, "⏳ در حال آپلود...");
        const fileUrl = await getTelegramFileUrl(env.BOT_TOKEN, msg.document.file_id);
        const buffer = await fetch(fileUrl).then(r => r.arrayBuffer());
        const filename = msg.document.file_name;
        // اگر کاربر /list path زده بود؟ فعلا روت آپلود میکنیم
        await webdavUpload(config, filename, buffer);
        await sendMessage(env.BOT_TOKEN, chatId, `✅ آپلود شد: ${filename}`);
      }

    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ خطا: ${e.message}`);
    }

    return new Response("OK");
  }
}

// ===== توابع WebDAV - با fetch و برای هر کاربر جدا =====
function getAuth(config) {
  return "Basic " + btoa(`${config.user}:${config.pass}`);
}

async function webdavList(config, path = "") {
  const url = path ? `${config.url}/${path}` : config.url;
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: { "Authorization": getAuth(config), "Depth": "1" }
  });
  if (!res.ok) throw new Error(`WebDAV Error ${res.status}`);
  const text = await res.text();
  const files = [...text.matchAll(/<d:href>(.*?)<\/d:href>/g)]
    .map(m => decodeURIComponent(m[1]))
    .map(href => href.split('/').filter(Boolean).pop())
    .filter(Boolean);
  // حذف نام روت
  const unique = [...new Set(files)];
  return unique.join("\n") || "پوشه خالی است";
}

async function webdavUpload(config, filename, buffer) {
  const res = await fetch(`${config.url}/${filename}`, {
    method: "PUT",
    headers: { "Authorization": getAuth(config) },
    body: buffer
  });
  if (!res.ok) throw new Error(`Upload failed ${res.status}`);
}

async function webdavDownload(config, filename) {
  const res = await fetch(`${config.url}/${filename}`, {
    headers: { "Authorization": getAuth(config) }
  });
  if (!res.ok) throw new Error(`File not found ${res.status}`);
  return await res.arrayBuffer();
}

async function webdavDelete(config, filename) {
  const res = await fetch(`${config.url}/${filename}`, {
    method: "DELETE",
    headers: { "Authorization": getAuth(config) }
  });
  if (!res.ok) throw new Error(`Delete failed ${res.status}`);
}

async function webdavMkdir(config, dirname) {
  const res = await fetch(`${config.url}/${dirname}`, {
    method: "MKCOL",
    headers: { "Authorization": getAuth(config) }
  });
  if (!res.ok && res.status !== 405) throw new Error(`Mkdir failed ${res.status}`);
}

// ===== تلگرام =====
async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
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
