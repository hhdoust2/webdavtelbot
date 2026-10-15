// ============================================================
//  WebDAV Multi-Account Telegram Bot  (Cloudflare Worker + KV)
//
//  متغیرهای لازم:
//    BOT_TOKEN       (Secret)  توکن ربات
//    USERS           (KV)      همان بایندینگ قبلی
//  متغیرهای اختیاری ولی بسیار توصیه‌شده (Secret):
//    WEBHOOK_SECRET  رمز وبهوک (فقط حروف انگلیسی/عدد/_/-) -> جلوگیری از جعل درخواست
//    ENCRYPTION_KEY  یک متن طولانی -> رمزنگاری پسوردهای ذخیره‌شده در KV
//    ALLOWED_USERS   آیدی عددی کاربران مجاز با کاما: 12345,67890
// ============================================================

const MAX_ACCOUNTS = 10; 
const TG_GET_LIMIT = 20 * 1024 * 1024; // ربات تلگرام تا 20MB می‌تواند فایل دریافت کند
const TG_SEND_LIMIT = 50 * 1024 * 1024; // ربات تلگرام تا 50MB می‌تواند فایل بفرستد
const UPLOAD_MODE_MS = 10 * 60 * 1000; // حالت آپلود بعد از 10 دقیقه خودکار تمام می‌شود

const BTN_ACCOUNTS = "👥 حساب‌ها";
const BTN_LIST = "📂 لیست فایل‌ها";
const BTN_UPLOAD = "📤 آپلود";
const BTN_ADD = "➕ حساب جدید";
const BTN_MAP = {
  [BTN_ACCOUNTS]: "/accounts",
  [BTN_LIST]: "/list",
  [BTN_UPLOAD]: "/upload",
  [BTN_ADD]: "/login",
};
const MAIN_KEYBOARD = {
  keyboard: [[{ text: BTN_ACCOUNTS }, { text: BTN_LIST }], [{ text: BTN_UPLOAD }, { text: BTN_ADD }]],
  resize_keyboard: true,
};

const KNOWN = new Set([
  "start", "help", "cancel", "login", "accounts", "account", "switch", "use",
  "logout", "rename", "list", "ls", "upload", "get", "del", "mkdir", "debug",
]);

const BOT_COMMANDS = [
  { command: "accounts", description: "لیست حساب‌ها و سوییچ" },
  { command: "login", description: "افزودن حساب جدید" },
  { command: "list", description: "لیست فایل‌ها" },
  { command: "upload", description: "آپلود فایل" },
  { command: "get", description: "دانلود فایل" },
  { command: "del", description: "حذف فایل/پوشه" },
  { command: "mkdir", description: "ساخت پوشه" },
  { command: "rename", description: "تغییر نام حساب فعال" },
  { command: "logout", description: "حذف حساب فعال" },
  { command: "debug", description: "تست اتصال" },
  { command: "help", description: "راهنما" },
];

const HELP = `📖 <b>راهنما</b>

👥 <b>حساب‌ها</b>
/accounts - لیست حساب‌ها و سوییچ بین آن‌ها
/login - افزودن حساب جدید (حساب‌های قبلی می‌مانند)
/use 2 - سوییچ سریع (شماره یا نام)
/rename نام - تغییر نام حساب فعال
/logout - حذف حساب فعال

📂 <b>فایل‌ها (روی حساب فعال)</b>
/list - لیست روت
/list data - لیست یک پوشه
/get data/a.zip - دانلود
/del data/a.zip - حذف (با تأیید)
/mkdir data/new - ساخت پوشه
/upload data - آپلود داخل پوشه، بعدش فایل‌ها را بفرست
یا مستقیم فایل بفرست؛ کپشن = پوشه (data/) یا مسیر کامل (data/a.txt)

🐛 /debug - تست اتصال
❌ /cancel - لغو عملیات

⚠️ محدودیت تلگرام: دریافت تا ۲۰ مگابایت، ارسال تا ۵۰ مگابایت.`;

// جلوگیری (تا حد ممکن) از پردازش دوباره‌ی آپدیت تکراری
const recent = new Set();

// ============================================================
//  ورودی اصلی
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      if (url.pathname === "/setup") return setup(url, env);
      return new Response("WebDAV Multi Bot is Running ✅");
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    if (env.WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (update.update_id !== undefined) {
      if (recent.has(update.update_id)) return new Response("OK");
      recent.add(update.update_id);
      if (recent.size > 300) recent.delete(recent.values().next().value);
    }

    try {
      if (update.callback_query) await handleCallback(update.callback_query, env);
      else if (update.message) await handleMessage(update.message, env);
    } catch (e) {
      console.log("ERROR:", e?.message);
    }
    return new Response("OK");
  },
};

// GET /setup?key=WEBHOOK_SECRET  -> ثبت وبهوک + منوی دستورات
async function setup(url, env) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
    return new Response("Forbidden (WEBHOOK_SECRET تنظیم نشده یا key اشتباه است)", { status: 403 });
  }
  const out = {};
  try {
    out.setWebhook = await tg(env, "setWebhook", {
      url: `${url.origin}/`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    });
    out.setMyCommands = await tg(env, "setMyCommands", { commands: BOT_COMMANDS });
  } catch (e) {
    out.error = e.message;
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
}

// ============================================================
//  پیام‌ها
// ============================================================
async function handleMessage(msg, env) {
  if (!msg.from || msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const send = (text, extra) => sendMessage(env, chatId, text, extra);

  if (!isAllowed(env, userId)) {
    await send(`⛔ دسترسی نداری.\nآیدی عددی شما: <code>${userId}</code>`);
    return;
  }

  let text = (msg.text || "").trim();
  if (BTN_MAP[text]) text = BTN_MAP[text];
  const cmd = parseCmd(text);
  const isKnownCmd = !!(cmd && KNOWN.has(cmd.cmd));
  const file = getIncomingFile(msg);

  const u = await loadUser(env, userId);
  let state = await env.USERS.get(`state:${userId}`, "json");
  if (state?.exp && Date.now() > state.exp) {
    await env.USERS.delete(`state:${userId}`);
    state = null;
  }

  try {
    // هر دستور جدید، مرحله‌ی نیمه‌تمام قبلی را لغو می‌کند
    if (isKnownCmd && state) {
      await env.USERS.delete(`state:${userId}`);
      state = null;
    }

    // ---------- مراحل ورودی متنی (ورود حساب / تغییر نام) ----------
    if (!isKnownCmd && !file && text && state) {
      if (state.step === "wait_url") {
        const url = parseDavUrl(text);
        if (!url) {
          await send("❌ آدرس باید با http:// یا https:// شروع شود.\nمثال: https://yourdomain.com:2078\n\n(لغو: /cancel)");
          return;
        }
        await putState(env, userId, { step: "wait_user", url });
        await send("👤 یوزرنیم WebDAV را بفرست:");
        return;
      }
      if (state.step === "wait_user") {
        await putState(env, userId, { step: "wait_pass", url: state.url, user: text });
        await send("🔒 پسورد WebDAV را بفرست:\n(پیام پسورد بعد از ارسال از چت پاک می‌شود)");
        return;
      }
      if (state.step === "wait_pass") {
        // پیام حاوی پسورد را فوراً پاک کن
        await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        await env.USERS.delete(`state:${userId}`);
        await send("⏳ در حال تست اتصال...");
        const cand = { url: state.url, user: state.user, pass: text };
        try {
          await webdavList(cand, "");
        } catch (e) {
          await send(`❌ اتصال ناموفق: ${esc(e.message)}\n\nدوباره /login بزن.`);
          return;
        }
        const acc = await addOrUpdateAccount(env, u, cand);
        await saveUser(env, userId, u);
        await send(
          `✅ وصل شد و حساب فعال شد:\n🔗 <b>${esc(acc.name)}</b>\n🌐 ${esc(hostOf(acc.url))} · 👤 ${esc(acc.user)}\n\n` +
            `برای تغییر نام: /rename\nبرای دیدن همه‌ی حساب‌ها: /accounts`,
          { reply_markup: MAIN_KEYBOARD }
        );
        return;
      }
      if (state.step === "wait_rename") {
        await env.USERS.delete(`state:${userId}`);
        await doRename(env, u, userId, text, send);
        return;
      }
      if (state.step === "wait_upload") {
        await send("📤 در حالت آپلود هستی؛ فایل را بفرست یا /cancel بزن.");
        return;
      }
    }

    // ---------- فایل دریافتی (آپلود) ----------
    if (file) {
      const acc = await activeAccount(env, u);
      await handleUpload(env, chatId, msg, file, state, acc, send);
      return;
    }

    // ---------- دستورات ----------
    if (!cmd || !isKnownCmd) {
      if (text) await send("دستور نامعتبر. /help را بزن.");
      return;
    }

    const arg = cmd.arg;
    switch (cmd.cmd) {
      case "start": {
        const a = u.accounts.find((x) => x.id === u.active);
        await send(
          `سلام 👋 به ربات مدیریت فایل WebDAV خوش آمدی.\n\n` +
            (a ? `حساب فعال: <b>${esc(a.name)}</b>\n\n` : `هنوز حسابی نداری؛ با /login اولین حساب را اضافه کن.\n\n`) +
            HELP,
          { reply_markup: MAIN_KEYBOARD }
        );
        return;
      }

      case "help":
        await send(HELP, { reply_markup: MAIN_KEYBOARD });
        return;

      case "cancel":
        await send("✅ لغو شد.");
        return;

      case "accounts":
      case "account": {
        const v = renderAccounts(u);
        await send(v.text, { reply_markup: v.markup });
        return;
      }

      case "switch":
      case "use": {
        if (!arg) {
          const v = renderAccounts(u);
          await send(v.text, { reply_markup: v.markup });
          return;
        }
        const a = findAccount(u, arg);
        if (!a) {
          await send("❌ حسابی با این شماره/نام پیدا نشد. /accounts");
          return;
        }
        u.active = a.id;
        await saveUser(env, userId, u);
        await send(`✅ حالا روی <b>${esc(a.name)}</b> هستی\n🌐 ${esc(hostOf(a.url))} · 👤 ${esc(a.user)}`);
        return;
      }

      case "login": {
        if (u.accounts.length >= MAX_ACCOUNTS) {
          await send(`❌ حداکثر ${MAX_ACCOUNTS} حساب مجاز است. اول یکی را حذف کن (/accounts).`);
          return;
        }
        await putState(env, userId, { step: "wait_url" });
        await send(startLoginText(u));
        return;
      }

      case "logout": {
        if (!u.accounts.length) {
          await send("حسابی برای حذف وجود ندارد.");
          return;
        }
        if (arg.toLowerCase() === "all") {
          await send(`🗑 همه‌ی ${u.accounts.length} حساب از ربات حذف شوند؟\n(به سرورهای WebDAV دست نمی‌زند)`, {
            reply_markup: { inline_keyboard: [[{ text: "✅ بله، همه", callback_data: "rmally" }, { text: "↩️ لغو", callback_data: "acc" }]] },
          });
          return;
        }
        const a = u.accounts.find((x) => x.id === u.active) || u.accounts[0];
        await send(confirmRemoveText(a), { reply_markup: confirmRemoveMarkup(a) });
        return;
      }

      case "rename": {
        if (!u.accounts.length) {
          await send("⛔ اول /login بزن.");
          return;
        }
        if (arg) {
          await doRename(env, u, userId, arg, send);
        } else {
          await putState(env, userId, { step: "wait_rename", exp: Date.now() + 5 * 60 * 1000 });
          await send("✏️ نام جدید حساب فعال را بفرست (حداکثر ۳۰ حرف):");
        }
        return;
      }

      case "upload": {
        const acc = await activeAccount(env, u);
        let target = "";
        try {
          target = normPath(arg).join("/");
        } catch (e) {
          await send(`❌ ${esc(e.message)}`);
          return;
        }
        if (target) target += "/";
        await putState(env, userId, { step: "wait_upload", target, exp: Date.now() + UPLOAD_MODE_MS });
        await send(
          `📤 آماده آپلود روی حساب <b>${esc(acc.name)}</b>\n📁 مقصد: <code>/${esc(target)}</code>\n\n` +
            `هر تعداد فایل بفرست (Document بهتر است؛ تا ۲۰ مگابایت).\n` +
            `حالت آپلود ۱۰ دقیقه فعال می‌ماند. پایان: /cancel`
        );
        return;
      }

      case "debug": {
        const acc = await activeAccount(env, u);
        const base = buildUrl(acc, "", true);
        const res = await fetch(base, {
          method: "PROPFIND",
          headers: { Authorization: getAuth(acc), Depth: "1", "Content-Type": "application/xml" },
          body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
        });
        const raw = await res.text();
        await send(
          `🔗 ${esc(acc.name)}\nStatus: ${res.status}\nURL: ${esc(base)}\n\n<pre>${esc(raw.slice(0, 3000) || "(خالی)")}</pre>`
        );
        return;
      }

      case "list":
      case "ls": {
        const acc = await activeAccount(env, u);
        const parts = normPath(arg);
        const items = await webdavList(acc, arg);
        const dirs = items.filter((i) => i.isDir).length;
        const header =
          `📂 <b>${esc(acc.name)}</b> : <code>/${esc(parts.join("/"))}</code>\n` +
          `${dirs} پوشه · ${items.length - dirs} فایل\n\n`;
        const lines = items.length
          ? items.map((i) =>
              i.isDir ? `📁 ${esc(i.name)}/` : `📄 ${esc(i.name)}${i.size != null ? ` · ${fmtSize(i.size)}` : ""}`
            )
          : ["(خالی)"];
        await sendLong(env, chatId, header, lines);
        return;
      }

      case "get": {
        if (!arg) {
          await send("مثال: /get data/file.zip");
          return;
        }
        const acc = await activeAccount(env, u);
        await send(`⏳ دانلود از <b>${esc(acc.name)}</b>: <code>${esc(arg)}</code>`);
        const blob = await webdavDownload(acc, arg);
        const name = normPath(arg).pop() || "file";
        await sendDocument(env, chatId, blob, name);
        return;
      }

      case "mkdir": {
        if (!arg) {
          await send("مثال: /mkdir data/new");
          return;
        }
        const acc = await activeAccount(env, u);
        await webdavMkdirp(acc, arg);
        await send(`✅ ساخته شد در <b>${esc(acc.name)}</b>: <code>${esc(normPath(arg).join("/"))}/</code>`);
        return;
      }

      case "del": {
        if (!arg) {
          await send("مثال: /del data/file.txt");
          return;
        }
        const acc = await activeAccount(env, u);
        const p = normPath(arg).join("/");
        if (!p) {
          await send("⛔ حذف روت مجاز نیست.");
          return;
        }
        await env.USERS.put(`pend:${userId}`, JSON.stringify({ accId: acc.id, path: p }), { expirationTtl: 300 });
        await send(
          `⚠️ از حساب <b>${esc(acc.name)}</b> حذف شود؟\n<code>/${esc(p)}</code>\n\n(اگر پوشه باشد با همه‌ی محتویاتش پاک می‌شود)`,
          { reply_markup: { inline_keyboard: [[{ text: "🗑 بله، حذف کن", callback_data: "dy" }, { text: "↩️ لغو", callback_data: "dn" }]] } }
        );
        return;
      }
    }
  } catch (e) {
    console.log("ERROR:", e?.message);
    await send(`❌ خطا: ${esc(e?.message || "نامشخص")}`).catch(() => {});
  }
}

// ============================================================
//  دکمه‌های شیشه‌ای
// ============================================================
async function handleCallback(cb, env) {
  const userId = cb.from.id;
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const data = cb.data || "";
  const answer = (text, alert = false) =>
    tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});

  if (!chatId) return answer();
  if (!isAllowed(env, userId)) return answer("⛔ دسترسی نداری", true);

  const edit = (text, markup) =>
    tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: markup,
    }).catch((e) => {
      if (!/not modified/i.test(e.message)) console.log("edit error:", e.message);
    });

  try {
    const u = await loadUser(env, userId);
    const [act, arg] = data.split(":");
    const id = Number(arg);

    switch (act) {
      case "acc": {
        const v = renderAccounts(u);
        await answer();
        return edit(v.text, v.markup);
      }

      case "sw": {
        const a = u.accounts.find((x) => x.id === id);
        if (!a) {
          await answer("این حساب دیگر وجود ندارد", true);
          const v = renderAccounts(u);
          return edit(v.text, v.markup);
        }
        if (u.active !== a.id) {
          u.active = a.id;
          await saveUser(env, userId, u);
        }
        await answer(`✅ حالا روی «${a.name}» هستی`);
        const v = renderAccounts(u);
        return edit(v.text, v.markup);
      }

      case "rm": {
        const a = u.accounts.find((x) => x.id === id);
        if (!a) return answer("پیدا نشد", true);
        await answer();
        return edit(confirmRemoveText(a), confirmRemoveMarkup(a));
      }

      case "rmy": {
        const a = u.accounts.find((x) => x.id === id);
        if (!a) return answer("قبلاً حذف شده", true);
        u.accounts = u.accounts.filter((x) => x.id !== id);
        if (u.active === id) u.active = u.accounts[0]?.id ?? null;
        await saveUser(env, userId, u);
        await answer(`🗑 «${a.name}» حذف شد`);
        const v = renderAccounts(u);
        return edit(v.text, v.markup);
      }

      case "rmally": {
        u.accounts = [];
        u.active = null;
        await saveUser(env, userId, u);
        await answer("همه‌ی حساب‌ها حذف شدند");
        const v = renderAccounts(u);
        return edit(v.text, v.markup);
      }

      case "add": {
        if (u.accounts.length >= MAX_ACCOUNTS) return answer(`حداکثر ${MAX_ACCOUNTS} حساب`, true);
        await putState(env, userId, { step: "wait_url" });
        await answer();
        return sendMessage(env, chatId, startLoginText(u));
      }

      case "dy": {
        const pend = await env.USERS.get(`pend:${userId}`, "json");
        await env.USERS.delete(`pend:${userId}`);
        if (!pend) {
          await answer("درخواست منقضی شد؛ دوباره /del بزن", true);
          return edit("⌛ درخواست حذف منقضی شد.");
        }
        const a = u.accounts.find((x) => x.id === pend.accId);
        if (!a) {
          await answer("حساب پیدا نشد", true);
          return edit("❌ این حساب دیگر وجود ندارد.");
        }
        await answer("در حال حذف...");
        const acc = { ...a, pass: await decPass(env, a.pass) };
        try {
          await webdavDelete(acc, pend.path);
          return edit(`✅ از <b>${esc(a.name)}</b> حذف شد:\n<code>/${esc(pend.path)}</code>`);
        } catch (e) {
          return edit(`❌ حذف ناموفق: ${esc(e.message)}`);
        }
      }

      case "dn": {
        await env.USERS.delete(`pend:${userId}`);
        await answer("لغو شد");
        return edit("↩️ حذف لغو شد.");
      }

      default:
        return answer();
    }
  } catch (e) {
    console.log("CB ERROR:", e?.message);
    await answer(`خطا: ${e?.message || ""}`.slice(0, 190), true);
  }
}

// ============================================================
//  آپلود
// ============================================================
async function handleUpload(env, chatId, msg, file, state, acc, send) {
  if (file.size && file.size > TG_GET_LIMIT) {
    throw new Error("تلگرام اجازه نمی‌دهد ربات فایل بزرگ‌تر از ۲۰ مگابایت دریافت کند.");
  }

  let folder = "";
  let fname = file.name;
  if (state?.step === "wait_upload") folder = state.target || "";

  const caption = (msg.caption || "").trim().replace(/^\/+/, "");
  if (caption) {
    const last = caption.split("/").pop();
    if (caption.endsWith("/")) {
      folder = caption;
    } else if (last.includes(".")) {
      const i = caption.lastIndexOf("/");
      folder = i >= 0 ? caption.slice(0, i + 1) : "";
      fname = last;
    } else {
      folder = caption + "/";
    }
  }

  fname = String(fname).replace(/[\\/]/g, "_");
  const finalPath = normPath(folder + fname).join("/");

  await send(`⏳ آپلود روی <b>${esc(acc.name)}</b>: <code>${esc(finalPath)}</code>`);

  const info = await tg(env, "getFile", { file_id: file.id }).catch((e) => {
    throw new Error(/too big/i.test(e.message) ? "فایل بزرگ‌تر از ۲۰ مگابایت است." : e.message);
  });
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.result.file_path}`);
  if (!r.ok) throw new Error(`دریافت فایل از تلگرام ناموفق بود (${r.status})`);
  const buffer = await r.arrayBuffer();

  await webdavUpload(acc, finalPath, buffer, file.mime || "application/octet-stream");

  let note = "";
  if (state?.step === "wait_upload") note = "\n\n📤 هنوز در حالت آپلود هستی؛ فایل بعدی را بفرست یا /cancel.";
  await send(`✅ آپلود شد روی <b>${esc(acc.name)}</b>:\n<code>/${esc(finalPath)}</code> (${fmtSize(buffer.byteLength)})${note}`);
}

function getIncomingFile(m) {
  if (m.document) {
    const d = m.document;
    return { id: d.file_id, name: d.file_name || `file_${d.file_unique_id}`, size: d.file_size, mime: d.mime_type };
  }
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1];
    return { id: p.file_id, name: `photo_${p.file_unique_id}.jpg`, size: p.file_size, mime: "image/jpeg" };
  }
  if (m.video) {
    const v = m.video;
    return { id: v.file_id, name: v.file_name || `video_${v.file_unique_id}.mp4`, size: v.file_size, mime: v.mime_type };
  }
  if (m.audio) {
    const a = m.audio;
    return { id: a.file_id, name: a.file_name || `${a.title || "audio_" + a.file_unique_id}.mp3`, size: a.file_size, mime: a.mime_type };
  }
  if (m.voice) {
    const v = m.voice;
    return { id: v.file_id, name: `voice_${v.file_unique_id}.ogg`, size: v.file_size, mime: v.mime_type };
  }
  if (m.animation) {
    const a = m.animation;
    return { id: a.file_id, name: a.file_name || `anim_${a.file_unique_id}.mp4`, size: a.file_size, mime: a.mime_type };
  }
  if (m.video_note) {
    const v = m.video_note;
    return { id: v.file_id, name: `videonote_${v.file_unique_id}.mp4`, size: v.file_size, mime: "video/mp4" };
  }
  return null;
}

// ============================================================
//  مدیریت حساب‌ها
// ============================================================
async function loadUser(env, userId) {
  let u = await env.USERS.get(`u:${userId}`, "json");
  if (u) return u;

  u = { accounts: [], active: null, nextId: 1 };

  // مهاجرت از نسخه‌ی قبلی (یک حساب در config:<id>)
  const old = await env.USERS.get(`config:${userId}`, "json");
  if (old?.url && old?.user) {
    const id = u.nextId++;
    u.accounts.push({
      id,
      name: autoName(old.url, []),
      url: String(old.url).replace(/\/+$/, ""),
      user: old.user,
      pass: await encPass(env, old.pass),
    });
    u.active = id;
    await saveUser(env, userId, u);
    await env.USERS.delete(`config:${userId}`);
  }
  return u;
}

async function saveUser(env, userId, u) {
  await env.USERS.put(`u:${userId}`, JSON.stringify(u));
}

async function putState(env, userId, state) {
  await env.USERS.put(`state:${userId}`, JSON.stringify(state));
}

async function activeAccount(env, u) {
  const a = u.accounts.find((x) => x.id === u.active);
  if (!a) throw new Error("هنوز حسابی انتخاب نشده. /login یا /accounts را بزن.");
  return { ...a, pass: await decPass(env, a.pass) };
}

async function addOrUpdateAccount(env, u, cand) {
  const encrypted = await encPass(env, cand.pass);
  let acc = u.accounts.find((a) => a.url === cand.url && a.user === cand.user);
  if (acc) {
    acc.pass = encrypted; // همان حساب است؛ فقط پسورد به‌روز شد
  } else {
    acc = {
      id: u.nextId++,
      name: autoName(cand.url, u.accounts),
      url: cand.url,
      user: cand.user,
      pass: encrypted,
    };
    u.accounts.push(acc);
  }
  u.active = acc.id;
  return acc;
}

function autoName(url, accounts) {
  let base = hostOf(url).replace(/^www\./, "").split(":")[0] || "webdav";
  base = base.slice(0, 26);
  let name = base;
  let i = 2;
  while (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) name = `${base} (${i++})`;
  return name;
}

function findAccount(u, q) {
  const n = Number(q);
  if (Number.isInteger(n) && n >= 1 && n <= u.accounts.length) return u.accounts[n - 1];
  const low = q.toLowerCase();
  return u.accounts.find((a) => a.name.toLowerCase() === low) || null;
}

async function doRename(env, u, userId, rawName, send) {
  const a = u.accounts.find((x) => x.id === u.active);
  if (!a) return send("⛔ حساب فعالی وجود ندارد.");
  const name = rawName.trim().slice(0, 30);
  if (!name) return send("❌ نام خالی است.");
  if (u.accounts.some((x) => x.id !== a.id && x.name.toLowerCase() === name.toLowerCase())) {
    return send("❌ حساب دیگری با این نام دارید؛ یک نام دیگر انتخاب کن.");
  }
  a.name = name;
  await saveUser(env, userId, u);
  return send(`✅ نام حساب فعال شد: <b>${esc(name)}</b>`);
}

function renderAccounts(u) {
  if (!u.accounts.length) {
    return {
      text: "👥 هنوز هیچ حسابی اضافه نکرده‌ای.\n\nبا /login یا دکمه‌ی زیر اولین حساب WebDAV را اضافه کن.",
      markup: { inline_keyboard: [[{ text: "➕ افزودن حساب", callback_data: "add" }]] },
    };
  }
  const lines = u.accounts.map(
    (a, i) =>
      `${a.id === u.active ? "✅" : "▫️"} <b>${i + 1}. ${esc(a.name)}</b>\n      🌐 ${esc(hostOf(a.url))}  ·  👤 ${esc(a.user)}`
  );
  const rows = u.accounts.map((a) => [
    { text: `${a.id === u.active ? "✅ " : "🔘 "}${a.name}`.slice(0, 40), callback_data: `sw:${a.id}` },
    { text: "🗑", callback_data: `rm:${a.id}` },
  ]);
  rows.push([{ text: "➕ افزودن حساب", callback_data: "add" }]);
  return {
    text: `👥 <b>حساب‌های شما (${u.accounts.length}/${MAX_ACCOUNTS})</b>\n\n${lines.join("\n\n")}\n\nروی نام هر حساب بزن تا سوییچ شود. ✅ = حساب فعال`,
    markup: { inline_keyboard: rows },
  };
}

function confirmRemoveText(a) {
  return `🗑 حساب <b>${esc(a.name)}</b> از ربات حذف شود؟\n(فقط اطلاعات ورود از ربات پاک می‌شود؛ به سرور WebDAV دست نمی‌زند)`;
}
function confirmRemoveMarkup(a) {
  return { inline_keyboard: [[{ text: "✅ بله، حذف", callback_data: `rmy:${a.id}` }, { text: "↩️ لغو", callback_data: "acc" }]] };
}

function startLoginText(u) {
  return (
    `🌐 آدرس WebDAV را بفرست:\nمثال: https://yourdomain.com:2078\n\n` +
    (u.accounts.length ? `(این حساب کنار ${u.accounts.length} حساب قبلی اضافه می‌شود)\n` : "") +
    `لغو: /cancel`
  );
}

function isAllowed(env, userId) {
  const list = String(env.ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length === 0 || list.includes(String(userId));
}

// ============================================================
//  رمزنگاری پسورد (اختیاری؛ اگر ENCRYPTION_KEY نباشد مثل قبل ذخیره می‌شود)
// ============================================================
async function getKey(env) {
  if (!env.ENCRYPTION_KEY) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const toB64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function encPass(env, plain) {
  const key = await getKey(env);
  if (!key) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return `enc:${toB64(iv)}.${toB64(ct)}`;
}

async function decPass(env, stored) {
  if (typeof stored !== "string" || !stored.startsWith("enc:")) return stored;
  const key = await getKey(env);
  if (!key) throw new Error("ENCRYPTION_KEY تنظیم نشده؛ نمی‌توان پسورد را خواند.");
  const [iv, ct] = stored.slice(4).split(".").map(fromB64);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("رمزگشایی پسورد ناموفق بود (ENCRYPTION_KEY عوض شده؟). حساب را دوباره اضافه کن.");
  }
}

// ============================================================
//  WebDAV
// ============================================================
function getAuth(acc) {
  const bytes = new TextEncoder().encode(`${acc.user}:${acc.pass}`); // پشتیبانی از حروف فارسی
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "Basic " + btoa(bin);
}

function parseDavUrl(t) {
  const s = t.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "");
  } catch {
    return String(url);
  }
}

function normPath(p) {
  const parts = String(p || "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== ".");
  if (parts.includes("..")) throw new Error("مسیر نامعتبر (..)");
  return parts;
}

function buildUrl(acc, path, isDir = false) {
  const base = acc.url.replace(/\/+$/, "");
  const enc = normPath(path).map(encodeURIComponent).join("/");
  return enc ? `${base}/${enc}${isDir ? "/" : ""}` : `${base}/`;
}

function httpErr(status, what) {
  if (status === 401) return new Error("نام کاربری یا پسورد اشتباه است (401)");
  if (status === 403) return new Error("دسترسی ممنوع است (403)");
  if (status === 404) return new Error("پیدا نشد (404)");
  if (status === 409) return new Error("پوشه‌ی مقصد وجود ندارد (409)");
  if (status === 413) return new Error("حجم فایل برای سرور زیاد است (413)");
  if (status === 423) return new Error("فایل قفل است (423)");
  if (status === 507) return new Error("فضای سرور پر است (507)");
  return new Error(`${what} (${status})`);
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`;

async function webdavList(acc, path = "") {
  const url = buildUrl(acc, path, true);
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: { Authorization: getAuth(acc), Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: PROPFIND_BODY,
  });
  if (res.status !== 207) {
    await res.body?.cancel().catch(() => {});
    if ([401, 403, 404].includes(res.status)) throw httpErr(res.status, "");
    throw new Error(`پاسخ نامعتبر از سرور (${res.status}). احتمالاً آدرس WebDAV درست نیست؛ /debug را بزن.`);
  }
  const xml = await res.text();
  return parseMultiStatus(xml, res.url || url);
}

function parseMultiStatus(xml, requestUrl) {
  const reqPath = safeDecode(new URL(requestUrl).pathname).replace(/\/+$/, "");
  const items = [];
  const seen = new Set();
  const re = /<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi;
  for (const m of xml.matchAll(re)) {
    const block = m[1];
    const href = xmlTag(block, "href");
    if (href == null) continue;
    let p;
    try {
      p = new URL(decodeXml(href.trim()), requestUrl).pathname;
    } catch {
      continue;
    }
    const decoded = safeDecode(p);
    if (decoded.replace(/\/+$/, "") === reqPath) continue; // خود پوشه
    const name = decoded.split("/").filter(Boolean).pop();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const rt = xmlTag(block, "resourcetype");
    const isDir = (rt != null && /collection/i.test(rt)) || p.endsWith("/");
    const len = xmlTag(block, "getcontentlength");
    items.push({ name, isDir, size: !isDir && len && /^\d+$/.test(len.trim()) ? Number(len) : null });
  }
  items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  return items;
}

function xmlTag(block, name) {
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i"));
  return m ? m[1] : null;
}
function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function webdavDownload(acc, path) {
  const parts = normPath(path);
  if (!parts.length || String(path).trim().endsWith("/")) throw new Error("این یک پوشه است، نه فایل.");
  const res = await fetch(buildUrl(acc, path), { headers: { Authorization: getAuth(acc) } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw httpErr(res.status, "دانلود ناموفق");
  }
  const len = Number(res.headers.get("content-length") || 0);
  const tooBig = (n) => new Error(`حجم فایل ${fmtSize(n)} است؛ تلگرام بیش از ۵۰ مگابایت اجازه نمی‌دهد.`);
  if (len > TG_SEND_LIMIT) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(len);
  }
  const blob = await res.blob();
  if (blob.size > TG_SEND_LIMIT) throw tooBig(blob.size);
  return blob;
}

async function webdavUpload(acc, path, buffer, contentType = "application/octet-stream") {
  const put = () =>
    fetch(buildUrl(acc, path), {
      method: "PUT",
      headers: { Authorization: getAuth(acc), "Content-Type": contentType },
      body: buffer,
    });
  let res = await put();
  if (res.status === 409) {
    // پوشه‌ی مقصد نیست؛ بساز و دوباره تلاش کن
    const parts = normPath(path);
    parts.pop();
    await webdavMkdirp(acc, parts.join("/"));
    res = await put();
  }
  if (![200, 201, 204].includes(res.status)) throw httpErr(res.status, "آپلود ناموفق");
}

async function webdavDelete(acc, path) {
  const parts = normPath(path);
  if (!parts.length) throw new Error("حذف روت مجاز نیست.");
  const res = await fetch(buildUrl(acc, path), { method: "DELETE", headers: { Authorization: getAuth(acc) } });
  if (![200, 202, 204].includes(res.status)) throw httpErr(res.status, "حذف ناموفق");
}

async function webdavMkdirp(acc, path) {
  const parts = normPath(path);
  if (!parts.length) throw new Error("نام پوشه خالی است.");
  for (let i = 1; i <= parts.length; i++) {
    const res = await fetch(buildUrl(acc, parts.slice(0, i).join("/"), true), {
      method: "MKCOL",
      headers: { Authorization: getAuth(acc) },
    });
    // 201 ساخته شد | 405 از قبل هست | 301/302/200 برخی سرورها برای پوشه‌ی موجود
    if (!res.ok && res.status !== 405) throw httpErr(res.status, "ساخت پوشه ناموفق");
  }
}

// ============================================================
//  تلگرام
// ============================================================
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!j?.ok) throw new Error(j?.description || `Telegram ${method} failed (${r.status})`);
  return j;
}

async function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

// پیام‌های طولانی (لیست فایل‌ها) را تکه‌تکه می‌فرستد (حداکثر ۴۰۹۶ حرف در هر پیام)
async function sendLong(env, chatId, header, lines) {
  const LIMIT = 3800;
  let chunk = header;
  for (const line of lines) {
    if (chunk.length + line.length + 1 > LIMIT && chunk.trim()) {
      await sendMessage(env, chatId, chunk);
      chunk = "";
    }
    chunk += line + "\n";
  }
  if (chunk.trim()) await sendMessage(env, chatId, chunk);
}

async function sendDocument(env, chatId, blob, filename) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", blob, filename);
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
  const j = await r.json().catch(() => null);
  if (!j?.ok) throw new Error(`ارسال فایل به تلگرام ناموفق بود: ${j?.description || r.status}`);
}

// ============================================================
//  ابزارهای کوچک
// ============================================================
function parseCmd(text) {
  const m = text.match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] || "").trim() } : null;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtSize(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
