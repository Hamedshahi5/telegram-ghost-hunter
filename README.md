# 👻 Ghost Hunter (v24.8.1)

A self-hosted Telegram "userbot" that runs entirely on **Cloudflare Workers** (Durable Objects + D1) and catches what Telegram tries to hide: **deleted messages, edited messages, and self-destructing (timer) media** — with a mobile-friendly RTL dashboard built in.

**[فارسی ⬇️ Persian version below](#-گوست-هانتر-v2481)**

> ⭐ If this project is useful to you, consider giving it a star — it helps others find it too.

---

## Features

- 🕵️ **Deleted message recovery** — recovers text (and cached media, when available) of messages deleted from your monitored chats.
- ✏️ **Edit tracking** — logs the old and new text whenever a message is edited.
- ⏱️ **Self-destructing media capture** — downloads "view once" photos/videos and voice notes before they disappear, falling back to forwarding into Saved Messages if the file is too large.
- 🖼️ **Media previews** — stores small previews (≤2MB) for regular incoming media so the dashboard can show a thumbnail even for large files.
- 🔗 **Direct download links** — the `.لینک` (`.link`) command turns any media message into a short-lived, rate-limited, use-limited download URL.
- 🎚️ **Configurable download cap** — `.s <MB>` adjusts the maximum file size the bot will fetch (5–50 MB).
- 🔔 **Silent badge notifications** — appends a superscript counter to your Telegram display name so you can see "new catches" at a glance, with automatic flood-wait handling.
- 🧹 **Self-cleaning storage** — orphaned media, expired download links, and old messages are swept on a recurring alarm.
- 📱 **Built-in dashboard** — a single-page, RTL, Persian-language UI (Alpine.js + Tailwind) for browsing events and managing stored files, protected by a cookie-based auth token.

## Architecture

- **Cloudflare Worker** (`src/index.ts`) — HTTP entrypoint, routing, auth, and the D1 schema for `messages` / `logs`.
- **Durable Object (`TelegramDO`)** — holds the live MTProto connection (via [GramJS](https://github.com/gram-js/gramjs)/`telegram`), listens for new/edited/deleted message events, manages its own SQLite storage for media blobs and download-link tokens, and runs a recurring `alarm()` for cleanup and reconnects.
- **D1 database** — durable log of chat messages (for detecting edits/deletions) and the event history shown in the dashboard.
- **Embedded HTML dashboard** — served directly from the Worker, no separate frontend deploy needed.

## Requirements

- A Cloudflare account with **Workers Paid** (Durable Objects + D1 require it) and Wrangler CLI.
- A Telegram **API ID / API Hash** from [my.telegram.org](https://my.telegram.org).
- A Telegram **user session string** (generated once via GramJS locally, then stored as a secret — this is a userbot, not a Bot API bot).

## Setup

1. Create a `wrangler.toml` with a D1 database binding named `DB` and a Durable Object binding named `TG` (class `TelegramDO`).
2. Set the following secrets/vars with `wrangler secret put` / `wrangler.toml` `[vars]`:

   | Name | Purpose |
   |---|---|
   | `SESSION` | GramJS `StringSession` for your Telegram user account |
   | `API_ID` / `API_HASH` | Telegram app credentials |
   | `AUTH_TOKEN` | Secret used to log into the dashboard (`?key=...`) |
   | `PUBLIC_URL` | Public URL of the deployed Worker, used to build `.لینک` download links |
   | `MONITOR_SELF` | `"true"` to also log your own outgoing messages |
   | `IGNORE_BOTS` | `"true"` to skip messages from bot accounts |

3. `wrangler deploy`.
4. Open the Worker URL with `?key=YOUR_AUTH_TOKEN` once to authenticate (sets a cookie).

## In-chat commands

Send these from your own account (they're deleted automatically after being processed):

- `.لینک` / `.link` — reply to a media message to generate a direct download link (valid 24h, max 5 uses).
- `.s` — show the current max download size.
- `.s <5-50>` — set the max download size in MB.

## Disclaimer

This project uses the Telegram **user** API (MTProto) rather than the Bot API, which means it operates as your personal account. Use it only on accounts you own, and make sure your usage complies with [Telegram's Terms of Service](https://telegram.org/tos) and applicable law in your jurisdiction.

## License

MIT — see [LICENSE](LICENSE).

---

# 👻 گوست هانتر (v24.8.1)

یک «یوزربات» تلگرام که کاملاً روی **Cloudflare Workers** (با Durable Objects و D1) اجرا می‌شود و همان چیزهایی را می‌گیرد که تلگرام سعی می‌کند پنهان کند: **پیام‌های حذف‌شده، پیام‌های ویرایش‌شده، و مدیای خودتخریب‌شونده (تایمردار)** — همراه با یک داشبورد موبایل‌فرندلی و راست‌چین.

## قابلیت‌ها

- 🕵️ **بازیابی پیام حذف‌شده** — متن (و در صورت وجود، مدیای کش‌شده) پیام‌های حذف‌شده از چت‌های تحت نظر را بازیابی می‌کند.
- ✏️ **ردیابی ویرایش** — متن قدیم و جدید هر پیام ویرایش‌شده را ثبت می‌کند.
- ⏱️ **گرفتن مدیای خودتخریب‌شونده** — عکس/ویدیوی «یک‌بار مشاهده» و ویس‌ها را قبل از ناپدید شدن دانلود می‌کند؛ اگر فایل خیلی بزرگ باشد، به Saved Messages فوروارد می‌کند.
- 🖼️ **پیش‌نمایش مدیا** — برای مدیای معمولی ورودی، پیش‌نمایش کوچک (حداکثر ۲ مگابایت) ذخیره می‌شود تا داشبورد حتی برای فایل‌های بزرگ هم تصویر کوچک نشان دهد.
- 🔗 **لینک دانلود مستقیم** — دستور `.لینک` روی هر پیام مدیادار، یک لینک دانلود کوتاه‌مدت با محدودیت تعداد استفاده می‌سازد.
- 🎚️ **سقف دانلود قابل‌تنظیم** — `.s <عدد>` حداکثر حجم فایلی که بات دانلود می‌کند را تنظیم می‌کند (۵ تا ۵۰ مگابایت).
- 🔔 **اعلان بی‌صدا با بج** — یک شمارنده به‌صورت اندیس بالا به اسم تلگرامت اضافه می‌کند تا «شکارهای جدید» را یک‌نگاه ببینی؛ همراه با مدیریت خودکار flood-wait.
- 🧹 **پاکسازی خودکار** — مدیای یتیم، لینک‌های منقضی‌شده و پیام‌های قدیمی به‌صورت دوره‌ای پاک می‌شوند.
- 📱 **داشبورد داخلی** — یک رابط تک‌صفحه‌ای، راست‌چین و فارسی (با Alpine.js و Tailwind) برای مرور رویدادها و مدیریت فایل‌های ذخیره‌شده، با احراز هویت مبتنی بر کوکی.

## معماری

- **Cloudflare Worker** (`src/index.ts`) — نقطهٔ ورود HTTP، مسیریابی، احراز هویت، و اسکیمای D1 برای جدول‌های `messages` و `logs`.
- **Durable Object با نام `TelegramDO`** — اتصال زندهٔ MTProto (از طریق کتابخانهٔ [GramJS](https://github.com/gram-js/gramjs)) را نگه می‌دارد، رویدادهای پیام جدید/ویرایش/حذف را می‌شنود، storage SQLite خودش را برای بلاب‌های مدیا و توکن‌های لینک دانلود مدیریت می‌کند، و یک `alarm()` دوره‌ای برای پاکسازی و اتصال مجدد اجرا می‌کند.
- **دیتابیس D1** — تاریخچهٔ ماندگار پیام‌ها (برای تشخیص ویرایش/حذف) و تاریخچهٔ رویدادهای نمایش‌داده‌شده در داشبورد.
- **داشبورد HTML تعبیه‌شده** — مستقیماً از خود Worker سرو می‌شود، نیازی به دیپلوی جداگانهٔ فرانت‌اند نیست.

## پیش‌نیازها

- یک اکانت Cloudflare با پلن **Workers Paid** (چون Durable Objects و D1 نیازش دارند) و ابزار Wrangler.
- **API ID / API Hash** تلگرام از [my.telegram.org](https://my.telegram.org).
- یک **رشتهٔ session** یوزر تلگرام (یک‌بار به‌صورت لوکال با GramJS ساخته و به‌عنوان secret ذخیره می‌شود — این یک یوزربات است، نه بات مبتنی بر Bot API).

## راه‌اندازی

۱. یک `wrangler.toml` بساز که یک باندینگ D1 با نام `DB` و یک باندینگ Durable Object با نام `TG` (کلاس `TelegramDO`) داشته باشد.

۲. متغیرهای زیر را با `wrangler secret put` یا در بخش `[vars]` فایل `wrangler.toml` تنظیم کن:

   | نام | کاربرد |
   |---|---|
   | `SESSION` | رشتهٔ `StringSession` گرم‌جی‌اس برای اکانت تلگرامت |
   | `API_ID` / `API_HASH` | اطلاعات اپلیکیشن تلگرام |
   | `AUTH_TOKEN` | رمز ورود به داشبورد (`?key=...`) |
   | `PUBLIC_URL` | آدرس عمومی Worker دیپلوی‌شده، برای ساخت لینک‌های `.لینک` |
   | `MONITOR_SELF` | مقدار `"true"` برای ثبت پیام‌های ارسالی خودت |
   | `IGNORE_BOTS` | مقدار `"true"` برای نادیده گرفتن پیام‌های بات‌ها |

۳. اجرای `wrangler deploy`.

۴. یک‌بار آدرس Worker را با `?key=TOKEN_تنظیم‌شده` باز کن تا وارد شوی (یک کوکی ذخیره می‌شود).

## دستورات داخل چت

این دستورات را از اکانت خودت بفرست (بعد از پردازش، خودکار حذف می‌شوند):

- `.لینک` — روی یک پیام مدیادار ریپلای کن تا لینک دانلود مستقیم بسازد (اعتبار ۲۴ ساعت، حداکثر ۵ بار استفاده).
- `.s` — نمایش سقف فعلی دانلود.
- `.s <۵ تا ۵۰>` — تنظیم سقف دانلود بر حسب مگابایت.

## سلب مسئولیت

این پروژه از API «یوزر» تلگرام (MTProto) استفاده می‌کند، نه Bot API؛ یعنی با اکانت شخصی خودت اجرا می‌شود. فقط روی اکانتی که مالکش هستی استفاده کن و مطمئن شو استفاده‌ات با [قوانین تلگرام](https://telegram.org/tos) و قوانین کشورت هم‌خوانی دارد.

## لایسنس

MIT — به فایل [LICENSE](LICENSE) نگاه کن.

> ⭐ اگه این پروژه به کارت اومد، یه ستاره بهش بده — کمک می‌کنه بقیه هم راحت‌تر پیداش کنن.
