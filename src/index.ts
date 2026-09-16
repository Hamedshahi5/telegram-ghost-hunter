// ================================================================
//  GHOST HUNTER v24.8.1 — FINAL
//  ✅ fmtSize صحیح (B / KB / MB)
//  ✅ نسخه UI به‌روز: v24.8
//  + همه قابلیت‌های v24.8
// ================================================================
import { DurableObject } from 'cloudflare:workers'
import { Api, TelegramClient } from 'telegram'
import { NewMessage, Raw } from 'telegram/events'
import { StringSession } from 'telegram/sessions'

// ---------- CONFIG ----------
const MAX_INLINE_BYTES   = 2 * 1024 * 1024
const DOWNLOAD_MAX_BYTES_DEFAULT = 50 * 1024 * 1024
const DOWNLOAD_MIN_MB    = 5
const DOWNLOAD_MAX_MB    = 50
const MEDIA_TTL_MS      = 3 * 86400 * 1000
const LINK_TTL_MS       = 24 * 3600 * 1000
const LINK_MAX_USES     = 5
const LINK_RATE_WINDOW  = 60_000
const LINK_RATE_LIMIT   = 10
const HISTORY_LIMIT     = 500
const BADGE_DEBOUNCE_MS = 60_000
const SAVED_NOTIFY_GAP  = 5 * 60_000
const DOWNLOAD_WORKERS  = 6
const ERROR_NOTIFY_GAP  = 5 * 60_000
const CRITICAL_NOTIFY_GAP = 60_000

const EXT: Record<string, string>  = { photo: 'jpg', voice: 'ogg', video_note: 'mp4', video: 'mp4', audio: 'mp3' }
const MIME: Record<string, string> = { jpg: 'image/jpeg', ogg: 'audio/ogg', mp4: 'video/mp4', mp3: 'audio/mpeg', bin: 'application/octet-stream' }

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const toSup    = (n: number) => String(n).split('').map(d => SUP[+d]).join('')
const stripSup = (s: string) => s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, '').trim()

const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tehran' })

// ✅ FIX: fmtSize کامل — B / KB / MB
const fmtSize = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function normalizeError(msg: string): string {
  return msg.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 100)
}

function mediaType(m: any): string {
  if (m instanceof Api.MessageMediaPhoto) return 'photo'
  if (m instanceof Api.MessageMediaDocument) {
    const attrs: any[] = m.document?.attributes ?? []
    if (attrs.some(a => a.className === 'DocumentAttributeRound')) return 'video_note'
    if (attrs.some(a => a.className === 'DocumentAttributeVoice')) return 'voice'
    if (m.document?.mimeType?.startsWith('video/')) return 'video'
    if (m.document?.mimeType?.startsWith('audio/')) return 'audio'
    return 'document'
  }
  return 'media'
}

function photoByteSize(photo: any): number {
  let max = 0
  for (const s of photo?.sizes ?? []) {
    if (s.className === 'PhotoSize' && s.size > max) max = s.size
    else if (s.className === 'PhotoSizeProgressive') {
      const mx = Math.max(...(s.sizes ?? [0]))
      if (mx > max) max = mx
    }
  }
  return max
}

function mediaSize(m: any): number {
  if (m?.document?.size) return m.document.size
  if (m instanceof Api.MessageMediaPhoto && m.photo) return photoByteSize(m.photo)
  return 0
}

function mimeOf(fname: string): string {
  const ext = fname.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

function mediaPlaceholder(m: any): string {
  const t = mediaType(m)
  return ({ photo: '[📷 عکس]', video: '[🎬 ویدیو]', video_note: '[⭕️ ویدیو گرد]',
             voice: '[🎤 ویس]', audio: '[🎵 آهنگ]', document: '[📎 فایل]' } as any)[t] || '[مدیا]'
}

function hasTimer(media: any): boolean {
  return Boolean(media) && typeof media.ttlSeconds === 'number'
}

function fmtUser(u: any): string {
  if (!u) return ''
  const base = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || 'Unknown'
  const handle = u.username ? `(@${u.username})` : (u.phone ? `(+${u.phone})` : '')
  return handle ? `${base} ${handle}` : base
}

async function fastDownload(client: TelegramClient, msg: any, workers = DOWNLOAD_WORKERS): Promise<any> {
  try {
    return await client.downloadMedia(msg, { workers })
  } catch (e: any) {
    if (String(e?.message ?? '').includes('workers')) {
      return await client.downloadMedia(msg, {})
    }
    throw e
  }
}

function hasAuthCookie(req: Request, token: string): boolean {
  const cookie = req.headers.get('cookie') || ''
  return cookie
    .split(';')
    .map(x => x.trim())
    .some(x => x === `gh=${token}`)
}

// ================================================================
//  DURABLE OBJECT
// ================================================================
export class TelegramDO extends DurableObject {
  client: TelegramClient | null = null
  starting: Promise<void> | null = null
  me: string = ''
  lastError: string = ''
  baseName: string = ''
  pending: number = 0
  badgeApplied: boolean = false
  badgeDirty: boolean = false
  floodUntil: number = 0
  lastSavedNotify: number = 0
  badgeTimer: any = null
  nameCache = new Map<string, string>()
  dlStats = { count: 0, totalBytes: 0, totalMs: 0, bestBps: 0 }
  maxDlBytes: number = DOWNLOAD_MAX_BYTES_DEFAULT
  lastErrorNotify: number = 0
  lastErrorKey: string = ''
  errorCount: number = 0
  stats = { raw: 0, new: 0, deleted: 0, edited: 0, media: 0, previews: 0, swept: 0, savedNotifs: 0, links: 0, downloads: 0, errorsReported: 0, lastRaw: '', lastNew: '', bootAt: '' }

  async ensure() {
    if ((this.client as any)?.connected) return
    if (this.starting) return this.starting
    this.starting = this.boot().finally(() => (this.starting = null))
    await this.starting
  }

  private async boot() {
    try {
      const env = this.env as any
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS media (fname TEXT PRIMARY KEY, blob BLOB, mime TEXT, ts INTEGER)`
      )
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS dlinks (
           token TEXT PRIMARY KEY,
           cid TEXT, mid TEXT,
           ts INTEGER,
           uses INTEGER DEFAULT 0,
           rateTs TEXT DEFAULT '[]'
         )`
      )
      try { this.ctx.storage.sql.exec(`ALTER TABLE dlinks ADD COLUMN uses INTEGER DEFAULT 0`) } catch {}
      try { this.ctx.storage.sql.exec(`ALTER TABLE dlinks ADD COLUMN rateTs TEXT DEFAULT '[]'`) } catch {}

      this.client = new TelegramClient(
        new StringSession(env.SESSION), Number(env.API_ID), env.API_HASH,
        { useWSS: true, autoReconnect: true, connectionRetries: 5, connections: DOWNLOAD_WORKERS }
      )
      await this.client.connect()
      const me: any = await this.client.getMe()
      this.me = me.username ? '@' + me.username : String(me.id)

      this.baseName = stripSup(me.firstName || me.username || 'Me')
      this.pending      = (await this.ctx.storage.get<number>('pending')) ?? 0
      this.badgeApplied = (await this.ctx.storage.get<boolean>('badgeApplied')) ?? false
      this.floodUntil   = (await this.ctx.storage.get<number>('floodUntil')) ?? 0
      this.maxDlBytes   = (await this.ctx.storage.get<number>('maxDlBytes')) ?? DOWNLOAD_MAX_BYTES_DEFAULT

      this.client.addEventHandler(
        (e: any) => this.onNew(e).catch(console.error), new NewMessage({})
      )
      this.client.addEventHandler(
        (u: any) => this.onRaw(u).catch(console.error), new Raw({})
      )
      this.stats.bootAt = now()
      await this.ctx.storage.setAlarm(Date.now() + 90_000)
      console.log('[BOOT] OK', this.me, '| pending:', this.pending,
        '| maxDl:', fmtSize(this.maxDlBytes), '| workers:', DOWNLOAD_WORKERS)

      if (this.pending > 0 || this.badgeApplied)
        this.flushBadge().catch(() => {})
      this.sweepOrphans().catch(() => {})

      const prevError = await this.ctx.storage.get<{ message: string; ts: number }>('lastError')
      if (prevError) {
        const elapsed = Math.round((Date.now() - prevError.ts) / 60000)
        await this.notifySaved(
          `✅ ریکاوری شد بعد از ${elapsed} دقیقه:\n${prevError.message.slice(0, 150)}`, true
        )
        await this.ctx.storage.delete('lastError')
      }
    } catch (e: any) {
      this.lastError = String(e?.message ?? e)
      this.client = null
      await this.ctx.storage.put('lastError', { message: this.lastError, ts: Date.now() })
      throw e
    }
  }

  // ---------- 🚨 گزارش خطا — throttle فقط بعد از موفقیت ----------
  private async notifySaved(message: string, isCritical: boolean = false) {
    const nowMs = Date.now()
    const gap = isCritical ? CRITICAL_NOTIFY_GAP : ERROR_NOTIFY_GAP

    const errorKey = normalizeError(message)

    if (errorKey === this.lastErrorKey && nowMs - this.lastErrorNotify < gap) {
      this.errorCount++
      return
    }
    if (nowMs - this.lastErrorNotify < gap) {
      this.errorCount++
      return
    }

    if (!this.client) return
    try {
      const suffix = this.errorCount > 0 ? ` (+${this.errorCount} بار دیگر)` : ''
      await this.client.sendMessage('me', {
        message: `🚨 GHOST | ${now()}\n${message}${suffix}`,
      })
      this.lastErrorNotify = nowMs
      this.lastErrorKey = errorKey
      const count = this.errorCount
      this.errorCount = 0
      this.stats.errorsReported++
      console.log('[ERROR-NOTIFY] OK:', message.slice(0, 60), count > 0 ? `(+${count})` : '')
    } catch (e: any) {
      console.error('[ERROR-NOTIFY] failed (retry later):', e?.message)
    }
  }

  // ---------- 👤 اسم با کش ----------
  private async userName(id: any): Promise<string | null> {
    if (!id) return null
    const key = String(id)
    const hit = this.nameCache.get(key)
    if (hit !== undefined) return hit
    try {
      const u: any = await this.client!.getEntity(id)
      if (u && (u.firstName || u.username || u.phone)) {
        const name = fmtUser(u)
        if (this.nameCache.size > 500) this.nameCache.clear()
        this.nameCache.set(key, name)
        return name
      }
    } catch {}
    return null
  }

  // ---------- 🔔 بج ----------
  private async bumpBadge(n: number) {
    this.pending += n
    await this.ctx.storage.put('pending', this.pending)
    if (!this.badgeTimer) {
      this.badgeTimer = setTimeout(() => {
        this.badgeTimer = null
        this.flushBadge().catch(() => {})
      }, BADGE_DEBOUNCE_MS)
    }
  }

  private async flushBadge() {
    if (!this.client) return
    if (this.pending === 0 && !this.badgeApplied) return
    if (Date.now() < this.floodUntil) {
      this.badgeDirty = true
      await this.notifySavedFallback('تغییر نام موقتاً محدود است')
      return
    }
    const name = this.pending > 0 ? `${this.baseName} ${toSup(this.pending)}` : this.baseName
    try {
      await this.client.invoke(new Api.account.UpdateProfile({ firstName: name }))
      this.badgeApplied = this.pending > 0
      this.badgeDirty = false
      await this.ctx.storage.put('badgeApplied', this.badgeApplied)
      console.log('[BADGE]', name)
    } catch (e: any) {
      this.badgeDirty = true
      const errStr = e?.errorMessage || String(e?.message ?? '')
      const m = errStr.match(/FLOOD_WAIT_(\d+)/)
      const secs = Number(e?.seconds) || (m ? +m[1] : 300)
      this.floodUntil = Date.now() + secs * 1000
      await this.ctx.storage.put('floodUntil', this.floodUntil)
      console.error('[BADGE] FLOOD_WAIT', secs, 's')
      await this.notifySavedFallback(`فلود ${Math.round(secs / 60)} دقیقه‌ای`)
    }
  }

  private async notifySavedFallback(reason: string) {
    if (this.pending <= 0) return
    if (Date.now() - this.lastSavedNotify < SAVED_NOTIFY_GAP) return
    try {
      await this.client!.sendMessage('me', {
        message: `👻 ${this.pending} شکار جدید (${reason}) — برای دیدن UI را باز کن`,
      })
      this.lastSavedNotify = Date.now()
      this.stats.savedNotifs++
      console.log('[NOTIFY-SAVED]', this.pending, 'catches')
    } catch (e: any) {
      console.error('[NOTIFY-SAVED] failed (retry later):', e?.message)
    }
  }

  // ---------- 🧹 پاکسازی یتیم‌ها ----------
  private async sweepOrphans() {
    try {
      const db = (this.env as any).DB
      const refs = new Set<string>()
      const m1 = await db.prepare("SELECT file_path FROM messages WHERE file_path != ''").all()
      for (const r of (m1.results ?? [])) refs.add(r.file_path)
      const m2 = await db.prepare("SELECT file_path FROM logs WHERE file_path != ''").all()
      for (const r of (m2.results ?? [])) refs.add(r.file_path)
      const rows = this.ctx.storage.sql.exec("SELECT fname FROM media WHERE fname LIKE 'del_%'").toArray()
      let swept = 0
      for (const row of rows) {
        if (!refs.has(row.fname)) {
          this.ctx.storage.sql.exec('DELETE FROM media WHERE fname = ?', row.fname)
          swept++
        }
      }
      if (swept > 0) { this.stats.swept += swept; console.log('[SWEEP]', swept) }
    } catch (e: any) {
      console.error('[SWEEP] err', e?.message)
      await this.notifySaved(`⚠️ sweepOrphans خطا: ${e?.message?.slice(0, 100)}`)
    }
  }

  // ---------- 📥 دستورات: .لینک و .s ----------
  private async handleCommands(event: any, cmdMsg: any) {
    const c = this.client!
    const say = async (text: string, replyTo?: number) => {
      await c.sendMessage(event.chatId, { message: text, replyTo, linkPreview: false }).catch(() => {})
    }
    try {
      const raw = (cmdMsg.message || '').trim()

      // ---------- 🎛 دستور .s ----------
      if (raw === '.s' || raw.startsWith('.s ')) {
        const arg = raw.slice(2).trim()
        if (!arg) {
          await say(
            `🎛 سقف دانلود فعلی: **${fmtSize(this.maxDlBytes)}**\n\n` +
            `برای تغییر: \`.s <عدد>\`\n` +
            `مثال: \`.s 75\` → سقف ۷۵ مگابایت\n` +
            `بازه مجاز: ${DOWNLOAD_MIN_MB} تا ${DOWNLOAD_MAX_MB} MB`
          )
          return
        }
        const num = parseInt(arg)
        if (isNaN(num) || num < DOWNLOAD_MIN_MB || num > DOWNLOAD_MAX_MB) {
          await say(`❌ عدد باید بین ${DOWNLOAD_MIN_MB} و ${DOWNLOAD_MAX_MB} باشد`, cmdMsg.id)
          return
        }
        this.maxDlBytes = num * 1024 * 1024
        await this.ctx.storage.put('maxDlBytes', this.maxDlBytes)
        await say(`✅ سقف دانلود روی **${num} MB** تنظیم شد`, cmdMsg.id)
        await c.deleteMessages(event.chatId, [cmdMsg.id], { revoke: true }).catch(() => {})
        return
      }

      // ---------- 📥 دستور .لینک ----------
      if (raw === '.لینک' || raw.toLowerCase() === '.link') {
        const replyToId = cmdMsg.replyTo?.replyToMsgId
        if (!replyToId) {
          await say('❌ روی یک پیام **مدیادار** (فایل/عکس/ویدیو) ریپلای کن', cmdMsg.id)
          return
        }
        const msgs: any[] = await c.getMessages(event.chatId, { ids: [replyToId] })
        const reply: any = msgs?.[0]
        const m = reply?.media
        if (!m || !(m instanceof Api.MessageMediaDocument || m instanceof Api.MessageMediaPhoto)) {
          await say('❌ روی یک پیام **مدیادار** (فایل/عکس/ویدیو) ریپلای کن', cmdMsg.id)
          return
        }
        const size = mediaSize(m)
        if (size > this.maxDlBytes) {
          await say(`❌ فایل ${fmtSize(size)} است — سقف فعلی ${fmtSize(this.maxDlBytes)}\n\n💡 با \`.s <عدد>\` می‌توانی سقف را بالا ببری`, cmdMsg.id)
          return
        }
        const base = String((this.env as any).PUBLIC_URL ?? '').replace(/\/$/, '')
        if (!base) {
          await say('⚠️ متغیر PUBLIC_URL در wrangler.toml تنظیم نشده', cmdMsg.id)
          return
        }
        const cid = String(event.chatId ?? ''), mid = String(reply.id)
        const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO dlinks (token, cid, mid, ts, uses, rateTs) VALUES (?,?,?,?,0,'[]')`,
          token, cid, mid, Date.now()
        )
        this.stats.links++
        const link = `${base}/dl/${cid}/${mid}?t=${token}`
        const hours = Math.round(LINK_TTL_MS / 3600000)
        const sizeLabel = size > 0 ? fmtSize(size) : 'اندازه نامشخص'
        await say(
          `📥 لینک دانلود مستقیم (${sizeLabel}):\n${link}\n\n` +
          `🔒 این لینک:\n` +
          `• تا ${hours} ساعت اعتبار دارد\n` +
          `• حداکثر ${LINK_MAX_USES} بار قابل استفاده است\n` +
          `• فقط برای همین فایل کار می‌کند`,
          reply.id
        )
        await c.deleteMessages(event.chatId, [cmdMsg.id], { revoke: true }).catch(() => {})
        return
      }
    } catch (e: any) {
      await say('❌ خطا: ' + (e?.message ?? 'نامشخص'), cmdMsg.id)
      await this.notifySaved(`⚠️ handleCommands: ${e?.message?.slice(0, 150)}`)
    }
  }

  // ---------- پیام جدید ----------
  private async onNew(event: any) {
    const msg: any = event.message
    if (!msg) return
    this.stats.new++
    this.stats.lastNew = `id:${msg.id} @ ${now()}`

    if (msg.out && msg.message) {
      const cmd = msg.message.trim()
      if (cmd === '.لینک' || cmd.toLowerCase() === '.link' || cmd === '.s' || cmd.startsWith('.s ')) {
        await this.handleCommands(event, msg)
        return
      }
    }

    const cidNum = Number(event.chatId ?? 0)
    if (event.isChannel || event.isGroup || cidNum < 0) return

    const f = this.env as any
    const flag = (k: string) => f[k] === 'true'
    if (!flag('MONITOR_SELF') && msg.out) return

    let senderName: string
    if (msg.out) {
      const peer = await this.userName(event.chatId ?? msg.peerId?.userId)
      senderName = peer ? `Me → ${peer}` : 'Me'
    } else {
      let s: any = null
      try { s = await event.getSender() } catch {}
      if (!s) { try { s = await this.client!.getEntity(msg.senderId) } catch {} }
      if (s && (s.firstName || s.username || s.phone)) {
        if (flag('IGNORE_BOTS') && s.bot) return
        senderName = fmtUser(s)
        this.nameCache.set(String(s.id ?? ''), senderName)
      } else {
        senderName = `User ${msg.senderId ?? '?'}`
      }
    }

    const text = msg.message || (msg.media ? mediaPlaceholder(msg.media) : '[بدون متن]')

    let mType = '', mFile = ''
    if (msg.media) {
      if (hasTimer(msg.media)) {
        await this.saveTimedMedia(msg, senderName)
      } else {
        try {
          const pv = await this.saveRegularMedia(msg)
          if (pv) { mType = pv.type; mFile = pv.fname; this.stats.previews++ }
        } catch (e: any) {
          await this.notifySaved(`⚠️ ذخیره پیش‌نمایش شکست: ${e?.message?.slice(0, 150)}`)
        }
      }
    }

    const cid = String(event.chatId ?? ''), mid = String(msg.id)
    const tsFull = new Date().toISOString()
    await f.DB.prepare(
      `INSERT INTO messages (cid, mid, text, sender, ts, media_type, file_path, edit_date)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(cid,mid) DO UPDATE SET text=excluded.text, edit_date=excluded.edit_date`
    ).bind(cid, mid, text, senderName, tsFull, mType, mFile, msg.editDate ?? null).run()
  }

  // 🖼🎬 ذخیره مدیای معمولی — با گزارش کامل خطاها
  private async saveRegularMedia(msg: any): Promise<{ type: string; fname: string } | null> {
    const m = msg.media
    if (!m) return null
    const type = mediaType(m)
    const size = mediaSize(m)

    if (size <= 0) {
      await this.copyToSaved(msg, `${type} | اندازه نامشخص`)
      return null
    }

    if (size > MAX_INLINE_BYTES) {
      await this.copyToSaved(msg, `${type} | بزرگ‌تر از ۲MB`)
      return null
    }

    let buf: any = null, ext = 'jpg', mime = 'image/jpeg'
    try {
      if (m instanceof Api.MessageMediaPhoto) {
        buf = await this.client!.downloadMedia(msg, {})
      } else if (m instanceof Api.MessageMediaDocument) {
        const doc: any = m.document
        const canFull = ['video', 'video_note', 'voice', 'audio'].includes(type)
                     && size > 0 && size <= MAX_INLINE_BYTES
        if (canFull) {
          buf = await fastDownload(this.client!, msg)
          ext = EXT[type] ?? 'bin'; mime = MIME[ext] ?? MIME.bin
        } else if (doc?.thumbs?.length) {
          buf = await this.client!.downloadMedia(msg, { thumb: doc.thumbs.length - 1 })
        } else return null
      } else return null
    } catch (e: any) {
      await this.notifySaved(
        `⚠️ دانلود پیش‌نمایش ${type} شکست خورد: ${String(e?.message ?? e).slice(0, 120)}`
      )
      return null
    }
    if (!buf) {
      await this.notifySaved(`⚠️ پیش‌نمایش ${type} دانلود شد اما خالی بود`)
      return null
    }

    const bytes = new Uint8Array(buf.buffer ?? buf)
    if (bytes.length > MAX_INLINE_BYTES) {
      await this.notifySaved(
        `⚠️ پیش‌نمایش ${type} واقعاً ${fmtSize(bytes.length)} شد (بزرگ‌تر از ۲MB)`
      )
      return null
    }

    const fname = `del_${type}_${msg.id}_${Date.now()}.${ext}`
    try {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO media (fname, blob, mime, ts) VALUES (?,?,?,?)`,
        fname, bytes, mime, Date.now()
      )
    } catch (e: any) {
      console.error('[SAVE-MEDIA] SQL err:', e?.message)
      await this.notifySaved(
        `⚠️ ذخیره پیش‌نمایش ${type} در storage شکست خورد: ${String(e?.message ?? e).slice(0, 120)}`
      )
      return null
    }
    return { type, fname }
  }

  // ---------- دانلود مدیای تایمردار ----------
  private async saveTimedMedia(msg: any, senderName: string) {
    this.stats.media++
    const ttl  = msg.media.ttlSeconds
    const type = mediaType(msg.media)
    const ext  = EXT[type] ?? 'bin'
    const fname = `${type}_${msg.id}_${Date.now()}.${ext}`
    const size = mediaSize(msg.media)
    const label = `${type} | ${senderName} | TTL ${ttl}s`
    let note: string
    let filePath = ''

    if (size <= 0) {
      note = '📄 اندازه نامشخص → کپی به Saved'
      const ok = await this.copyToSaved(msg, label)
      if (!ok) note = '⚠️ اندازه نامشخص + کپی به Saved شکست خورد!'
      await this.log('timer_media', {
        sender_name: senderName, media_type: type, ttl,
        file_path: filePath, file_size: '?', note,
      })
      return
    }

    if (size > MAX_INLINE_BYTES) {
      note = `📄 ${fmtSize(size)} بزرگ بود → کپی به Saved`
      const ok = await this.copyToSaved(msg, label)
      if (!ok) note = '⚠️ کپی به Saved هم شکست خورد!'
    } else {
      try {
        const buf: any = await fastDownload(this.client!, msg)
        const bytes = new Uint8Array(buf.buffer ?? buf)
        if (bytes.length > MAX_INLINE_BYTES) {
          note = `📄 ${fmtSize(bytes.length)} بزرگ بود (SQL) → کپی به Saved`
          const ok = await this.copyToSaved(msg, label)
          if (!ok) note = '⚠️ کپی به Saved هم شکست خورد!'
        } else {
          this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO media (fname, blob, mime, ts) VALUES (?,?,?,?)`,
            fname, bytes, MIME[ext] ?? MIME.bin, Date.now()
          )
          filePath = fname
          note = `✅ ذخیره شد (${fmtSize(bytes.length)})`
        }
      } catch (e: any) {
        note = '⚠️ دانلود ناموفق → کپی به Saved'
        const ok = await this.copyToSaved(msg, label)
        if (!ok) note = '⚠️ دانلود و کپی هر دو شکست خوردند!'
        await this.notifySaved(`⚠️ دانلود تایمردار شکست (${type}): ${e?.message?.slice(0, 100)}`)
      }
    }
    await this.log('timer_media', {
      sender_name: senderName, media_type: type, ttl,
      file_path: filePath, file_size: fmtSize(size), note,
    })
  }

  private async copyToSaved(msg: any, label: string): Promise<boolean> {
    try {
      await this.client!.sendFile('me', {
        file: msg.media, message: `👻 GHOST | ${label}`, forceDocument: false,
      })
      return true
    } catch (e1: any) {
      try {
        await this.client!.forwardMessages('me', {
          messages: [msg.id], fromPeer: msg.chatId
        })
        return true
      } catch (e2: any) {
        await this.notifySaved(
          `🚨 ذخیره در Saved شکست خورد\n${label}\n` +
          `${String(e2?.message ?? e1?.message ?? '').slice(0, 150)}`,
          true
        )
        return false
      }
    }
  }

  // ---------- ویرایش / حذف ----------
  private async onRaw(update: any) {
    this.stats.raw++
    const list: any[] = update?.className === 'Updates' ? (update.updates ?? []) : [update]
    for (const u of list) {
      this.stats.lastRaw = `${u?.className} @ ${now()}`
      if (u instanceof Api.UpdateEditMessage) await this.onEdited(u.message)
      else if (u instanceof Api.UpdateDeleteMessages)
        for (const id of u.messages) await this.recoverDeleted(Number(id))
    }
  }

  private async onEdited(msg: any) {
    if (!(msg instanceof Api.Message)) return
    const db = (this.env as any).DB
    const cid = String(msg.chatId ?? ''), mid = String(msg.id)
    const row = await db.prepare('SELECT text, sender, edit_date FROM messages WHERE cid=? AND mid=?')
      .bind(cid, mid).first<any>()
    if (!row) return
    if (row.edit_date && msg.editDate && Number(row.edit_date) === Number(msg.editDate)) return
    const newText = msg.message || (msg.media ? mediaPlaceholder(msg.media) : '[بدون متن]')
    if (newText === '[بدون متن]' && row.text.startsWith('[')) return
    if (row.text === newText) return
    this.stats.edited++
    await this.log('edited', { sender_name: row.sender, old_text: row.text, new_text: newText })
    await db.prepare('UPDATE messages SET text=?, edit_date=? WHERE cid=? AND mid=?')
      .bind(newText, msg.editDate ?? null, cid, mid).run()
  }

  private async recoverDeleted(mid: number) {
    const db = (this.env as any).DB
    const row = await db.prepare('SELECT cid, text, sender, media_type, file_path FROM messages WHERE mid=? LIMIT 1')
      .bind(String(mid)).first<any>()
    if (!row) return
    let filePath: string = row.file_path || ''
    let mType: string = row.media_type || ''
    if (filePath) {
      const exists = this.ctx.storage.sql.exec('SELECT 1 FROM media WHERE fname=?', filePath).toArray().length > 0
      if (!exists) { filePath = ''; mType = '' }
    }
    this.stats.deleted++
    await this.log('deleted', {
      sender_name: row.sender, content: row.text,
      media_type: mType, file_path: filePath,
      note: filePath ? '🖼 بازیابی شد' : '',
    })
    await db.prepare('DELETE FROM messages WHERE cid=? AND mid=?').bind(row.cid, String(mid)).run()
  }

  private async log(type: string, x: Record<string, any>) {
    const tsFull = new Date().toISOString()
    await (this.env as any).DB.prepare(
      `INSERT INTO logs (id, ts, type, sender_name, content, old_text, new_text,
                         media_type, ttl, file_path, file_size, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(crypto.randomUUID(), tsFull, type, x.sender_name ?? '', x.content ?? '',
      x.old_text ?? '', x.new_text ?? '', x.media_type ?? '', x.ttl ?? null,
      x.file_path ?? '', x.file_size ?? '', x.note ?? '').run()
    await this.bumpBadge(1)
  }

  async alarm() {
    try {
      await this.ensure()
      await this.client!.getMe()
      this.ctx.storage.sql.exec('DELETE FROM media WHERE ts < ?', Date.now() - MEDIA_TTL_MS)
      this.ctx.storage.sql.exec('DELETE FROM dlinks WHERE ts < ?', Date.now() - LINK_TTL_MS)
      await (this.env as any).DB.prepare("DELETE FROM messages WHERE ts < datetime('now','-3 day')").run()
      await this.sweepOrphans()
      if ((this.badgeDirty || this.pending > 0 || this.badgeApplied) && Date.now() >= this.floodUntil)
        await this.flushBadge()
    } catch (e: any) {
      await this.notifySaved(`⚠️ alarm خطا: ${e?.message?.slice(0, 100)}`)
    }
    await this.ctx.storage.setAlarm(Date.now() + 120_000)
  }

  // ---------- 📥 دانلود /dl/{cid}/{mid}?t=token ----------
  private async serveDownload(req: Request) {
    try {
      if (req.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 })
      }

      await this.ensure()
      const url = new URL(req.url)
      const parts = url.pathname.split('/')
      const cid = parts[2] ?? '', mid = parts[3] ?? ''
      const token = url.searchParams.get('t') ?? ''

      const rows = this.ctx.storage.sql.exec(
        'SELECT ts, uses, rateTs FROM dlinks WHERE token=? AND cid=? AND mid=?', token, cid, mid
      ).toArray()
      const rec = rows[0]
      if (!rec) return new Response('🔒 لینک نامعتبر است', { status: 403 })

      const nowMs = Date.now()

      if (nowMs - rec.ts > LINK_TTL_MS) {
        this.ctx.storage.sql.exec('DELETE FROM dlinks WHERE token=?', token)
        return new Response('⏱ لینک منقضی شده است', { status: 410 })
      }

      if (rec.uses >= LINK_MAX_USES) {
        return new Response(`🚫 سقف ${LINK_MAX_USES} بار استفاده از این لینک پر شده`, { status: 429 })
      }

      let rateArr: number[] = []
      try { rateArr = JSON.parse(rec.rateTs || '[]') } catch {}
      rateArr = rateArr.filter((t: number) => nowMs - t < LINK_RATE_WINDOW)
      if (rateArr.length >= LINK_RATE_LIMIT) {
        return new Response('🐌 بیش از حد سریع — چند لحظه صبر کن', { status: 429 })
      }
      rateArr.push(nowMs)

      this.ctx.storage.sql.exec(
        'UPDATE dlinks SET rateTs = ? WHERE token = ?',
        JSON.stringify(rateArr), token
      )

      let msg: any
      try {
        const msgs = await this.client!.getMessages(Number(cid), { ids: [Number(mid)] })
        msg = msgs?.[0]
      } catch (e: any) {
        return new Response('❌ دسترسی به چت ممکن نشد: ' + (e?.message ?? ''), { status: 500 })
      }
      if (!msg?.media) return new Response('❌ مدیا پیدا نشد (پیام حذف شده؟)', { status: 404 })

      const size = mediaSize(msg.media)
      if (size > this.maxDlBytes) {
        return new Response(`❌ فایل ${fmtSize(size)} — سقف ${fmtSize(this.maxDlBytes)}`, { status: 413 })
      }

      let fileName = `file_${mid}`
      if (msg.media instanceof Api.MessageMediaDocument && msg.media.document) {
        for (const a of ((msg.media.document as any).attributes ?? [])) {
          if (a.className === 'DocumentAttributeFilename' && a.fileName) fileName = a.fileName
        }
      } else if (msg.media instanceof Api.MessageMediaPhoto) {
        fileName = `photo_${mid}.jpg`
      }

      console.log('[DL] start', fileName, size > 0 ? fmtSize(size) : 'size-unknown', `(${DOWNLOAD_WORKERS} workers)`)
      const t0 = Date.now()
      const buf: any = await fastDownload(this.client!, msg)

      if (!buf) {
        await this.notifySaved(`⚠️ دانلود شکست خورد (null): ${fileName}`)
        return new Response('❌ دانلود شکست خورد', { status: 500 })
      }

      const bytes = new Uint8Array(buf.buffer ?? buf)
      if (!bytes.length) {
        await this.notifySaved(`⚠️ دانلود خالی: ${fileName}`)
        return new Response('❌ فایل خالی', { status: 500 })
      }

      // 🔴 authoritative size check بعد از دانلود
      if (bytes.length > this.maxDlBytes) {
        return new Response(
          `❌ فایل واقعی ${fmtSize(bytes.length)} است — سقف ${fmtSize(this.maxDlBytes)}`,
          { status: 413 }
        )
      }

      const elapsedMs = Date.now() - t0
      const bps = bytes.length / (elapsedMs / 1000)
      this.dlStats.count++
      this.dlStats.totalBytes += bytes.length
      this.dlStats.totalMs += elapsedMs
      if (bps > this.dlStats.bestBps) this.dlStats.bestBps = bps

      this.ctx.storage.sql.exec('UPDATE dlinks SET uses = uses + 1 WHERE token = ?', token)

      console.log(`[DL] OK ${bytes.length} bytes in ${(elapsedMs/1000).toFixed(1)}s ≈ ${fmtSize(bps)}/s`)
      this.stats.downloads++
      return new Response(bytes, {
        headers: {
          'content-type': mimeOf(fileName),
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'content-length': String(bytes.length),
          'cache-control': 'private, no-store',
        },
      })

    } catch (e: any) {
      console.error('[DL] fatal:', e?.stack || e?.message || e)
      await this.notifySaved(`🚨 دانلود fatal: ${e?.message?.slice(0, 200)}`, true)
      return new Response('❌ خطای دانلود: ' + (e?.message ?? String(e)), { status: 500 })
    }
  }

  async fetch(req: Request) {
    const path = new URL(req.url).pathname

    if (path.startsWith('/dl/')) return this.serveDownload(req)
    if (path === '/wake')  { await this.ensure().catch(() => {}); return Response.json({ ok: true }) }

    if (path === '/seen') {
      await this.ensure().catch(() => {})
      this.pending = 0
      await this.ctx.storage.put('pending', 0)
      if ((this.badgeApplied || this.badgeDirty) && Date.now() >= this.floodUntil)
        await this.flushBadge().catch(() => {})
      return Response.json({ ok: true, pending: this.pending })
    }

    if (path === '/stats') {
      const avgBps = this.dlStats.totalMs > 0
        ? this.dlStats.totalBytes / (this.dlStats.totalMs / 1000)
        : 0
      return Response.json({
        workers: DOWNLOAD_WORKERS,
        downloads: this.dlStats.count,
        totalBytes: fmtSize(this.dlStats.totalBytes),
        avgSpeed: fmtSize(avgBps) + '/s',
        bestSpeed: fmtSize(this.dlStats.bestBps) + '/s',
      })
    }

    if (path === '/allfiles') {
      const rows = this.ctx.storage.sql.exec(
        'SELECT fname, length(blob) sz, mime, ts FROM media ORDER BY ts DESC'
      ).toArray()
      return Response.json({
        count: rows.length,
        total: fmtSize(rows.reduce((a: any, r: any) => a + (r.sz || 0), 0)),
        files: rows.map((r: any) => ({
          fname: r.fname,
          size: fmtSize(r.sz || 0),
          mime: r.mime,
          ts: new Date(r.ts).toLocaleString('sv-SE', { timeZone: 'Asia/Tehran' }),
        })),
      })
    }

    if (path === '/testname') {
      await this.ensure()
      try {
        await this.client!.invoke(new Api.account.UpdateProfile({ firstName: this.baseName }))
        this.floodUntil = 0
        await this.ctx.storage.put('floodUntil', 0)
        return Response.json({ ok: true, note: 'تغییر نام آزاد است ✅' })
      } catch (e: any) {
        return Response.json({
          ok: false,
          error: e?.errorMessage || String(e?.message ?? ''),
          waitSeconds: Number(e?.seconds) ?? null,
          floodUntil: this.floodUntil ? new Date(this.floodUntil).toLocaleString('sv-SE', { timeZone: 'Asia/Tehran' }) : null,
        })
      }
    }

    if (path === '/test') {
      await this.ensure()
      try {
        const r: any = await this.client!.sendMessage('me', { message: `GHOST TEST ${Date.now()}` })
        return Response.json({ ok: true, messageId: r?.id })
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message }, { status: 500 })
      }
    }

    if (path === '/files') {
      const rows = this.ctx.storage.sql.exec(
        'SELECT fname, length(blob) sz, ts FROM media ORDER BY ts DESC'
      ).toArray()
      return Response.json({
        count: rows.length,
        total: fmtSize(rows.reduce((a: any, r: any) => a + (r.sz || 0), 0)),
        files: rows.map((r: any) => ({ fname: r.fname, size: fmtSize(r.sz || 0), ts: new Date(r.ts).toLocaleString('sv-SE', { timeZone: 'Asia/Tehran' }) })),
      })
    }

    if (path === '/status') {
      await this.ensure().catch(() => {})
      let c = { c: 0, s: 0 }
      try {
        c = this.ctx.storage.sql.exec('SELECT count(*) c, IFNULL(sum(length(blob)),0) s FROM media').toArray()[0]
      } catch {}
      const avgBps = this.dlStats.totalMs > 0
        ? this.dlStats.totalBytes / (this.dlStats.totalMs / 1000)
        : 0
      return Response.json({
        connected: Boolean((this.client as any)?.connected),
        me: this.me || null, bootAt: this.stats.bootAt || null,
        pending: this.pending, badgeApplied: this.badgeApplied, badgeDirty: this.badgeDirty,
        floodUntil: this.floodUntil ? new Date(this.floodUntil).toLocaleString('sv-SE', { timeZone: 'Asia/Tehran' }) : null,
        maxDl: fmtSize(this.maxDlBytes),
        stats: {
          rawUpdates: this.stats.raw, newMessages: this.stats.new,
          deletedFound: this.stats.deleted, editsFound: this.stats.edited,
          timerMedia: this.stats.media, previews: this.stats.previews,
          sweptOrphans: this.stats.swept, savedNotifs: this.stats.savedNotifs,
          errorsReported: this.stats.errorsReported,
          downloadLinks: this.stats.links, downloads: this.stats.downloads,
          workers: DOWNLOAD_WORKERS,
          dlCount: this.dlStats.count,
          dlTotal: fmtSize(this.dlStats.totalBytes),
          dlAvgSpeed: fmtSize(avgBps) + '/s',
          dlBestSpeed: fmtSize(this.dlStats.bestBps) + '/s',
          lastRaw: this.stats.lastRaw || null, lastNew: this.stats.lastNew || null,
        },
        lastError: this.lastError || null,
        files: c.c, storage: fmtSize(c.s),
      })
    }

    if (path === '/delmedia') {
      const fname = new URL(req.url).searchParams.get('fname') ?? ''
      if (fname) this.ctx.storage.sql.exec('DELETE FROM media WHERE fname = ?', fname)
      return Response.json({ ok: true })
    }

    if (path === '/clear') {
      this.ctx.storage.sql.exec('DELETE FROM media')
      const c = this.ctx.storage.sql.exec('SELECT count(*) c FROM media').toArray()[0]
      return Response.json({ ok: true, remaining: c.c })
    }

    if (path.startsWith('/media/')) {
      await this.ensure()
      const fname = decodeURIComponent(path.slice(7))
      const row = this.ctx.storage.sql.exec('SELECT blob, mime FROM media WHERE fname = ?', fname).toArray()[0]
      if (!row) return new Response('not found / expired', { status: 404 })
      return new Response(row.blob as Uint8Array, {
        headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=3600' },
      })
    }
    return new Response('nf', { status: 404 })
  }
}

// ================================================================
//  WORKER
// ================================================================
let schemaReady = false
async function ensureSchema(env: any) {
  if (schemaReady) return
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
      cid TEXT, mid TEXT, text TEXT, sender TEXT, ts TEXT, PRIMARY KEY (cid, mid))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY, ts TEXT, type TEXT, sender_name TEXT, content TEXT,
      old_text TEXT, new_text TEXT, media_type TEXT, ttl INTEGER,
      file_path TEXT, file_size TEXT, note TEXT)`),
  ])
  for (const [tbl, col] of [
    ['messages', 'media_type TEXT'], ['messages', 'file_path TEXT'],
    ['messages', 'chat_title TEXT'], ['messages', 'edit_date INTEGER'],
    ['logs', 'chat_title TEXT'],
  ]) {
    try { await env.DB.prepare(`ALTER TABLE ${tbl} ADD COLUMN ${col}`).run() } catch {}
  }
  schemaReady = true
}

export default {
  async fetch(req: Request, env: any, ctx: any) {
    const url  = new URL(req.url)
    const stub = env.TG.get(env.TG.idFromName('main'))
    await ensureSchema(env)

    if (url.pathname.startsWith('/dl/')) return stub.fetch(req)

    const auth = hasAuthCookie(req, env.AUTH_TOKEN)
              || url.searchParams.get('key') === env.AUTH_TOKEN

    if (url.pathname === '/' && url.searchParams.get('key') === env.AUTH_TOKEN) {
      const h = new Headers({ 'Location': '/' })
      h.set('Set-Cookie', `gh=${env.AUTH_TOKEN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`)
      return new Response(null, { status: 302, headers: h })
    }

    if (url.pathname === '/') {
      if (!auth) return new Response('🔒 اول با ?key=YOUR_TOKEN وارد شو', { status: 403 })
      const h = new Headers({ 'content-type': 'text/html;charset=utf-8' })
      h.append('Set-Cookie', `gh=${env.AUTH_TOKEN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`)
      ctx.waitUntil(stub.fetch('https://do/seen').catch(() => {}))
      return new Response(HTML, { headers: h })
    }
    if (!auth) return new Response('forbidden', { status: 403 })

    if (url.pathname === '/api/logs') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM logs ORDER BY ts DESC LIMIT ' + HISTORY_LIMIT
      ).all()
      const entries = (results ?? []).map((r: any) => ({
        timestamp: r.ts,
        data: { [r.type]: [{ id: r.id, sender_name: r.sender_name, content: r.content,
          old_text: r.old_text, new_text: r.new_text, media_type: r.media_type,
          ttl: r.ttl, file_path: r.file_path, file_size: r.file_size, note: r.note }] },
      }))
      return Response.json(entries)
    }

    if (url.pathname === '/api/delete' && req.method === 'POST') {
      const { id } = await req.json().catch(() => ({ id: '' }))
      if (!id) return Response.json({ ok: false }, { status: 400 })
      const row: any = await env.DB.prepare('SELECT file_path FROM logs WHERE id=?').bind(id).first()
      if (row?.file_path) {
        await stub.fetch('https://do/delmedia?fname=' + encodeURIComponent(row.file_path))
      }
      await env.DB.prepare('DELETE FROM logs WHERE id=?').bind(id).run()
      ctx.waitUntil(stub.fetch('https://do/seen').catch(() => {}))
      return Response.json({ ok: true })
    }

    if (url.pathname === '/api/delfile' && req.method === 'POST') {
      const { fname } = await req.json().catch(() => ({ fname: '' }))
      if (!fname) return Response.json({ ok: false }, { status: 400 })
      await stub.fetch('https://do/delmedia?fname=' + encodeURIComponent(fname))
      return Response.json({ ok: true })
    }

    if (url.pathname === '/api/clear' && req.method === 'POST') {
      await env.DB.batch([env.DB.prepare('DELETE FROM logs'), env.DB.prepare('DELETE FROM messages')])
      const r = await stub.fetch('https://do/clear')
      const j: any = await r.json().catch(() => ({}))
      ctx.waitUntil(stub.fetch('https://do/seen').catch(() => {}))
      return Response.json({ status: 'cleared', filesLeft: j.remaining ?? -1 })
    }

    if (url.pathname.startsWith('/media/')) return stub.fetch(req)
    if (url.pathname === '/allfiles')  return stub.fetch('https://do/allfiles')
    if (url.pathname === '/status')    return stub.fetch('https://do/status')
    if (url.pathname === '/stats')     return stub.fetch('https://do/stats')
    if (url.pathname === '/test')      return stub.fetch('https://do/test')
    if (url.pathname === '/testname')  return stub.fetch('https://do/testname')
    if (url.pathname === '/files')     return stub.fetch('https://do/files')
    return new Response('nf', { status: 404 })
  },

  async scheduled(_e: any, env: any) {
    await env.TG.get(env.TG.idFromName('main')).fetch('https://do/wake')
  },
}

// ================================================================
//  UI — نسخه v24.8.1
// ================================================================
const HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>GHOST HUNTER v24.8</title>
<script src="https://cdn.tailwindcss.com"></script>
<script defer src="https://unpkg.com/@alpinejs/collapse@3.x.x/dist/cdn.min.js"></script>
<script src="https://unpkg.com/alpinejs" defer></script>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Vazirmatn:wght@400;500;700&display=swap" rel="stylesheet">
<style>
body{font-family:'Vazirmatn',sans-serif;background:#000;color:#e4e4e7;overscroll-behavior-y:contain}
.font-mono{font-family:'JetBrains Mono',monospace}
.safe-top{padding-top:env(safe-area-inset-top)}.safe-bottom{padding-bottom:env(safe-area-inset-bottom)}
.no-scrollbar::-webkit-scrollbar{display:none}.no-scrollbar{-ms-overflow-style:none;scrollbar-width:none}
.animate-enter{animation:slideIn .2s ease-out forwards}
@keyframes slideIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.media-blur{filter:blur(15px);transition:filter .3s ease}.media-revealed{filter:blur(0)}
[x-cloak]{display:none!important}
.fadein{animation:fadeIn .15s ease-out forwards}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
</style>
</head>
<body x-data="app()" class="h-screen flex flex-col overflow-hidden bg-black selection:bg-blue-500/30 safe-top">

<div class="flex bg-[#050505] border-b border-[#111] px-2 pt-2 gap-1 z-30">
  <button @click="tab='feed'" class="flex-1 py-2.5 text-xs font-bold transition-all border-b-2"
    :class="tab==='feed' ? 'text-blue-400 border-blue-500' : 'text-gray-600 border-transparent'">🔔 رویدادها</button>
  <button @click="tab='files';loadFiles()" class="flex-1 py-2.5 text-xs font-bold transition-all border-b-2"
    :class="tab==='files' ? 'text-emerald-400 border-emerald-500' : 'text-gray-600 border-transparent'">📂 فایل‌ها</button>
</div>

<div x-show="tab==='feed'" class="flex-1 flex flex-col overflow-hidden">

<header class="bg-black/90 backdrop-blur-md border-b border-[#111] px-4 py-3 flex justify-between items-center sticky top-0 z-30">
  <div>
    <h1 class="font-bold text-base tracking-wide text-white">GHOST HUNTER <span class="text-[10px] text-blue-500 font-mono">v24.8·PM</span></h1>
    <div class="flex items-center gap-1.5 text-[9px] text-gray-500 font-mono mt-0.5">
      <span class="w-1.5 h-1.5 rounded-full animate-pulse" :class="status.connected ? 'bg-emerald-500' : 'bg-red-500'"></span>
      <span x-text="status.connected ? 'LIVE' : 'OFFLINE'"></span>
      <span>•</span><span x-text="filteredLogs.length"></span><span>MSG</span>
      <span>•</span><span x-text="(status.files||0)+' فایل'"></span><span>•</span><span x-text="status.storage"></span>
    </div>
  </div>
  <button @click="showSearch=!showSearch" class="p-2 text-gray-400 hover:text-white active:scale-90 transition">
    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
  </button>
</header>

<div x-show="showSearch" x-collapse class="bg-[#0a0a0a] border-b border-[#111] px-4 py-2 z-20">
  <input x-model="searchQuery" @input="filterLogs()" type="text" placeholder="جستجو در پیام، فرستنده..."
    class="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50 font-mono">
</div>

<div class="flex gap-2 px-4 py-3 overflow-x-auto no-scrollbar border-b border-[#111]/50 bg-black/50 z-20">
  <template x-for="f in filters" :key="f.id">
    <button @click="setFilter(f.id)"
      class="whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-medium transition-all active:scale-95 border"
      :class="activeFilter===f.id ? 'bg-blue-500/20 border-blue-500/50 text-blue-400' : 'bg-[#111] border-[#222] text-gray-500'"
      x-text="f.label + (f.count>0 ? ' ('+f.count+')' : '')"></button>
  </template>
</div>

<div class="flex-1 overflow-y-auto p-3 space-y-3 pb-24" x-ref="feed">
  <template x-if="filteredLogs.length===0">
    <div class="flex flex-col items-center justify-center h-64 text-gray-800 font-mono text-xs opacity-50 mt-10">[ NO DATA ]</div>
  </template>

  <template x-for="ev in filteredLogs" :key="ev.id">
    <div class="relative animate-enter select-none"
      x-data="{ swipeX: 0, startX: 0, swiping: false }"
      @touchstart.passive="startX=$event.touches[0].clientX; swiping=true"
      @touchmove.passive="if(swiping) swipeX=Math.min(Math.max($event.touches[0].clientX-startX,-80),80)"
      @touchend="handleSwipeEnd(swipeX, ev); swipeX=0; swiping=false"
      :style="'transform: translateX('+swipeX+'px); transition: '+(swiping?'none':'transform .2s ease-out')">

      <div class="pl-3 border-r-2 transition-all duration-200"
        :class="{'border-red-500':ev.type==='deleted','border-yellow-500':ev.type==='edited','border-purple-500':ev.type==='timer_media'}">

        <div class="flex justify-between items-baseline mb-1.5 px-1">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-sm font-bold text-gray-200 truncate max-w-[200px]" x-text="ev.sender_name"></span>
            <span class="text-[8px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wider shrink-0"
              :class="{'bg-red-900/30 text-red-400':ev.type==='deleted','bg-yellow-900/30 text-yellow-400':ev.type==='edited','bg-purple-900/30 text-purple-400':ev.type==='timer_media'}"
              x-text="getTypeLabel(ev.type)"></span>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-[9px] font-mono text-gray-600" x-text="formatTs(ev.fullTimestamp || ev.timestamp)"></span>
            <button @click.stop="deleteLog(ev)" class="text-gray-700 hover:text-red-500 active:scale-90 transition p-0.5 text-sm">🗑</button>
          </div>
        </div>

        <div class="bg-[#0a0a0a] p-3 rounded-l-lg rounded-br-lg border border-[#1a1a1a] active:bg-[#111] transition-colors" @click="handleCardClick(ev)">

          <template x-if="ev.type==='deleted'">
            <div>
              <p class="text-gray-300 text-sm whitespace-pre-wrap leading-relaxed line-clamp-4" :class="{'line-clamp-none':ev.expanded}" x-text="ev.content"></p>
              <template x-if="ev.file_path && ev.file_path.endsWith('.jpg')">
                <div class="mt-2 relative overflow-hidden rounded-lg border border-red-900/30 bg-[#111] aspect-video cursor-pointer" @click.stop="openViewer(ev)">
                  <img :src="'/media/'+encodeURIComponent(ev.file_path)" loading="lazy" class="w-full h-full object-cover fadein">
                  <span class="absolute bottom-1 left-1 text-[8px] bg-black/70 px-1.5 py-0.5 rounded font-mono text-red-300">بازیابی‌شده 👻</span>
                </div>
              </template>
              <template x-if="ev.file_path && ev.file_path.endsWith('.mp4')">
                <div class="mt-2">
                  <video :src="'/media/'+encodeURIComponent(ev.file_path)" controls preload="metadata" playsinline webkit-playsinline
                    class="w-full rounded-lg border border-red-900/30"></video>
                  <p class="text-[8px] text-red-300 font-mono mt-1">🎬 بازیابی‌شده 👻</p>
                </div>
              </template>
              <template x-if="ev.file_path && (ev.file_path.endsWith('.ogg') || ev.file_path.endsWith('.mp3'))">
                <div class="mt-2">
                  <audio :src="'/media/'+encodeURIComponent(ev.file_path)" controls preload="metadata" class="w-full"></audio>
                  <p class="text-[8px] text-red-300 font-mono mt-1">🎤 بازیابی‌شده 👻</p>
                </div>
              </template>
            </div>
          </template>

          <template x-if="ev.type==='edited'">
            <div class="space-y-2">
              <div class="pr-2 border-r border-gray-800">
                <p class="text-gray-500 text-xs line-through opacity-60 line-clamp-2" x-text="ev.old_text"></p>
              </div>
              <div class="pr-2 border-r border-yellow-900/50">
                <p class="text-gray-200 text-sm leading-relaxed line-clamp-3" :class="{'line-clamp-none':ev.expanded}" x-text="ev.new_text"></p>
              </div>
            </div>
          </template>

          <template x-if="ev.type==='timer_media'">
            <div>
              <div class="flex items-center gap-2 mb-2 text-[10px] text-purple-400 font-mono">
                <span class="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse"></span>
                <span x-text="getMediaLabel(ev.media_type)"></span>
                <span class="bg-purple-900/20 px-1 rounded" x-text="ev.ttl>0 ? ev.ttl+'s' : 'ONE TIME'"></span>
                <span class="text-gray-600 mr-auto" x-text="ev.file_size"></span>
              </div>
              <template x-if="ev.file_path">
                <div class="relative w-full overflow-hidden rounded-lg border border-purple-900/30 bg-[#111] aspect-video flex items-center justify-center cursor-pointer" @click.stop="toggleMedia(ev)">
                  <template x-if="!ev.revealed">
                    <div class="absolute inset-0 flex flex-col items-center justify-center z-10">
                      <span class="text-3xl mb-1 opacity-40">👁️</span>
                      <span class="text-[9px] text-gray-500 font-mono">TAP TO REVEAL</span>
                    </div>
                  </template>
                  <template x-if="ev.revealed && ev.media_type==='photo'">
                    <img :src="'/media/'+encodeURIComponent(ev.file_path)" loading="lazy"
                      class="w-full h-full object-cover transition-all duration-500 media-revealed">
                  </template>
                  <template x-if="ev.revealed && ['video','video_note'].includes(ev.media_type)">
                    <video preload="metadata" playsinline webkit-playsinline muted
                      class="w-full h-full object-cover transition-all duration-500 media-revealed"
                      :src="'/media/'+encodeURIComponent(ev.file_path)"></video>
                  </template>
                  <template x-if="ev.revealed && ['voice','audio'].includes(ev.media_type)">
                    <div class="w-full px-4 py-3">
                      <audio preload="metadata" controls class="w-full h-8"
                        :src="'/media/'+encodeURIComponent(ev.file_path)"></audio>
                    </div>
                  </template>
                  <template x-if="ev.revealed && ev.media_type==='document'">
                    <div class="text-center z-10"><span class="text-2xl">📎</span>
                      <p class="text-[9px] text-gray-500 font-mono mt-1" x-text="ev.note"></p></div>
                  </template>
                </div>
              </template>
              <div class="flex items-center justify-between mt-1.5">
                <p class="text-[9px] text-gray-600 font-mono" x-text="ev.note"></p>
                <p class="text-[8px] text-gray-700 font-mono" x-show="ev.file_path">دوباره بزن = تمام‌صفحه</p>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </template>
</div>
</div>

<div x-show="tab==='files'" class="flex-1 flex flex-col overflow-hidden">

<header class="bg-black/90 backdrop-blur-md border-b border-[#111] px-4 py-3 flex justify-between items-center sticky top-0 z-30">
  <div>
    <h1 class="font-bold text-base tracking-wide text-emerald-400">📂 مدیریت فایل‌ها</h1>
    <div class="text-[9px] text-gray-500 font-mono mt-0.5">
      <span x-text="files.length"></span> فایل • <span x-text="filesTotal"></span>
    </div>
  </div>
  <button @click="loadFiles()" class="p-2 text-gray-400 hover:text-emerald-400 active:scale-90 transition text-xl">🔄</button>
</header>

<div class="px-4 py-2 border-b border-[#111]">
  <input x-model="fileSearch" type="text" placeholder="جستجوی نام فایل..."
    class="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50 font-mono">
</div>

<div class="flex-1 overflow-y-auto p-3 space-y-2 pb-24">
  <template x-if="files.length===0">
    <div class="flex flex-col items-center justify-center h-64 text-gray-800 font-mono text-xs opacity-50">[ NO FILES ]</div>
  </template>

  <template x-for="f in filteredFiles()" :key="f.fname">
    <div class="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-3 flex items-center gap-3 active:bg-[#111] transition-colors">
      <div class="w-10 h-10 rounded-lg bg-[#111] flex items-center justify-center text-xl shrink-0">
        <span x-text="fileIcon(f.fname)"></span>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-xs text-gray-200 font-mono truncate" x-text="f.fname"></p>
        <p class="text-[9px] text-gray-500 font-mono mt-0.5">
          <span x-text="f.size"></span> • <span x-text="f.ts"></span>
        </p>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button @click="previewFile(f)" class="w-8 h-8 rounded-lg bg-[#111] flex items-center justify-center text-sm active:scale-90 transition" title="نمایش">👁</button>
        <a :href="'/media/'+encodeURIComponent(f.fname)" :download="f.fname"
          class="w-8 h-8 rounded-lg bg-[#111] flex items-center justify-center text-sm active:scale-90 transition" title="دانلود">⬇️</a>
        <button @click="deleteFile(f)" class="w-8 h-8 rounded-lg bg-[#111] flex items-center justify-center text-sm text-red-400 active:scale-90 transition" title="حذف">🗑</button>
      </div>
    </div>
  </template>
</div>
</div>

<div x-show="viewer.open" x-cloak class="fixed inset-0 bg-black z-50 flex flex-col fadein" x-transition.opacity>
  <div class="flex justify-between items-center px-4 py-3 safe-top bg-black/80">
    <span class="text-[10px] text-gray-400 font-mono truncate max-w-[60%]" x-text="viewer.label"></span>
    <div class="flex items-center gap-4">
      <a :href="'/media/'+encodeURIComponent(viewer.path)" download class="text-xl text-gray-300 active:scale-90 transition">⬇️</a>
      <button @click="closeViewer()" class="text-2xl text-white leading-none active:scale-90 transition">✕</button>
    </div>
  </div>
  <div class="flex-1 flex items-center justify-center overflow-hidden p-2 safe-bottom" @click.self="closeViewer()">
    <template x-if="viewer.type==='photo'">
      <img :src="'/media/'+encodeURIComponent(viewer.path)" class="max-w-full max-h-full object-contain fadein">
    </template>
    <template x-if="['video','video_note'].includes(viewer.type)">
      <video :src="'/media/'+encodeURIComponent(viewer.path)" controls autoplay playsinline webkit-playsinline
        class="max-w-full max-h-full object-contain"></video>
    </template>
    <template x-if="['voice','audio'].includes(viewer.type)">
      <div class="w-full px-8">
        <div class="text-center text-5xl mb-4">🎧</div>
        <audio :src="'/media/'+encodeURIComponent(viewer.path)" controls autoplay class="w-full"></audio>
      </div>
    </template>
  </div>
</div>

<nav class="bg-[#050505]/95 backdrop-blur-lg border-t border-[#111] px-6 py-3 safe-bottom flex justify-around items-center z-40">
  <button @click="tab='feed';fetchLogs(true)" class="flex flex-col items-center gap-1 text-gray-500 active:text-blue-400 active:scale-90 transition-all">
    <span class="text-lg">🔔</span><span class="text-[8px] font-mono">EVENTS</span>
  </button>
  <button @click="tab='files';loadFiles()" class="flex flex-col items-center gap-1 text-gray-500 active:text-emerald-400 active:scale-90 transition-all">
    <span class="text-lg">📂</span><span class="text-[8px] font-mono">FILES</span>
  </button>
  <button @click="clearLogs()" class="flex flex-col items-center gap-1 text-gray-500 active:text-red-500 active:scale-90 transition-all">
    <span class="text-lg">🗑️</span><span class="text-[8px] font-mono">WIPE</span>
  </button>
</nav>

<div x-show="toast.show" x-transition.opacity.duration.200ms
  class="fixed top-20 left-1/2 -translate-x-1/2 bg-[#111] border border-[#222] text-white text-xs px-4 py-2 rounded-full shadow-2xl z-[60] font-mono pointer-events-none flex items-center gap-2">
  <span x-text="toast.icon"></span><span x-text="toast.msg"></span>
</div>

<script>
function app(){return{
  tab:'feed',
  logs:[],filteredLogs:[],status:{connected:true,storage:'',files:0,maxDl:''},
  files:[],fileSearch:'',
  showSearch:false,searchQuery:'',activeFilter:'all',toast:{show:false,msg:'',icon:''},
  viewer:{open:false,type:'',path:'',label:''},
  filters:[
    {id:'all',label:'همه',count:0},
    {id:'deleted',label:'حذف شده',count:0},
    {id:'edited',label:'ویرایش',count:0},
    {id:'timer_media',label:'مدیا',count:0}
  ],
  get filesTotal(){
    return this.status.storage || '';
  },
  init(){
    this.fetchLogs(); this.fetchStatus();
    setInterval(()=>{if(!document.hidden){this.fetchLogs();this.fetchStatus()}},4000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.fetchLogs()});
  },
  formatTs(ts){
    if(!ts)return'';
    try{
      const d=new Date(ts);
      if(isNaN(d.getTime()))return ts;
      const now=new Date();
      const sameDay =
        d.toLocaleDateString('fa-IR',{timeZone:'Asia/Tehran'}) ===
        now.toLocaleDateString('fa-IR',{timeZone:'Asia/Tehran'});
      if(sameDay){
        return d.toLocaleTimeString('fa-IR',{timeZone:'Asia/Tehran',hour:'2-digit',minute:'2-digit'});
      }
      return d.toLocaleDateString('fa-IR',{timeZone:'Asia/Tehran',month:'2-digit',day:'2-digit'})
        +' '+d.toLocaleTimeString('fa-IR',{timeZone:'Asia/Tehran',hour:'2-digit',minute:'2-digit'});
    }catch(e){return ts}
  },
  async loadFiles(){
    try{
      const r=await fetch('/allfiles');
      if(r.ok){
        const j=await r.json();
        this.files=j.files||[];
        this.status.storage=j.total||'';
        this.status.files=j.count||0;
      }
    }catch(e){}
    if(navigator.vibrate)navigator.vibrate(15);
  },
  filteredFiles(){
    if(!this.fileSearch.trim())return this.files;
    const q=this.fileSearch.toLowerCase();
    return this.files.filter(f=>f.fname.toLowerCase().includes(q));
  },
  fileIcon(fname){
    if(fname.endsWith('.jpg'))return '🖼';
    if(fname.endsWith('.mp4'))return '🎬';
    if(fname.endsWith('.ogg'))return '🎤';
    if(fname.endsWith('.mp3'))return '🎵';
    return '📎';
  },
  previewFile(f){
    const fp=f.fname;
    let type='photo';
    if(fp.endsWith('.mp4'))type='video';
    else if(fp.endsWith('.ogg')||fp.endsWith('.mp3'))type='voice';
    this.viewer={open:true,type,path:fp,label:f.fname+' • '+f.size};
    if(navigator.vibrate)navigator.vibrate(15);
  },
  async deleteFile(f){
    if(!confirm('حذف شود؟\\n'+f.fname))return;
    try{
      await fetch('/api/delfile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fname:f.fname})});
    }catch(e){}
    this.files=this.files.filter(x=>x.fname!==f.fname);
    this.showToast('حذف شد','🗑️');
    if(navigator.vibrate)navigator.vibrate([30,20,30]);
  },
  async fetchLogs(manual){
    try{
      const res=await fetch('/api/logs');
      if(res.ok){this.processLogs(await res.json());this.status.connected=true}
      else this.status.connected=false;
    }catch(e){this.status.connected=false}
    if(manual&&navigator.vibrate)navigator.vibrate(30);
  },
  async fetchStatus(){
    try{const r=await fetch('/status');if(r.ok)this.status=await r.json()}catch(e){}
  },
  processLogs(raw){
    let flat=[];
    raw.forEach(entry=>{
      const fullTs=entry.timestamp;
      const ts=fullTs.split('T')[1]?.slice(0,5) || fullTs;
      const add=(item,type)=>flat.push({...item,id:item.id||type+ts+Math.random(),type,
        timestamp:ts, fullTimestamp:fullTs, expanded:false,revealed:false});
      for(const t of['deleted','edited','timer_media'])if(entry.data[t])entry.data[t].forEach(x=>add(x,t));
    });
    const sorted=flat.sort((a,b)=>(b.fullTimestamp||'').localeCompare(a.fullTimestamp||''));
    const state={};this.logs.forEach(l=>state[l.id]={expanded:l.expanded,revealed:l.revealed});
    this.logs=sorted.map(l=>({...l,expanded:state[l.id]?.expanded||false,revealed:state[l.id]?.revealed||false}));
    this.updateCounts(); this.filterLogs();
  },
  updateCounts(){
    this.filters[0].count=this.logs.length;
    this.filters[1].count=this.logs.filter(l=>l.type==='deleted').length;
    this.filters[2].count=this.logs.filter(l=>l.type==='edited').length;
    this.filters[3].count=this.logs.filter(l=>l.type==='timer_media').length;
  },
  setFilter(id){this.activeFilter=id;this.filterLogs();if(navigator.vibrate)navigator.vibrate(20)},
  filterLogs(){
    let r=this.logs;
    if(this.activeFilter!=='all')r=r.filter(l=>l.type===this.activeFilter);
    if(this.searchQuery.trim()){
      const q=this.searchQuery.toLowerCase();
      r=r.filter(l=>(l.content||'').toLowerCase().includes(q)||(l.new_text||'').toLowerCase().includes(q)||(l.sender_name||'').toLowerCase().includes(q));
    }
    this.filteredLogs=r;
  },
  handleSwipeEnd(dx,ev){
    if(dx>60){const t=ev.content||ev.new_text||'';
      if(t)navigator.clipboard.writeText(t).then(()=>this.showToast('کپی شد','📋'));
    }else if(dx<-60){this.filteredLogs=this.filteredLogs.filter(l=>l.id!==ev.id);this.showToast('مخفی شد','🙈')}
  },
  toggleMedia(ev){
    if(navigator.vibrate)navigator.vibrate(20);
    if(!ev.revealed){ev.revealed=true;return}
    if(ev.file_path)this.openViewer(ev);
  },
  openViewer(ev){
    const fp=ev.file_path||'';
    let type='photo';
    if(fp.endsWith('.mp4'))type='video';
    else if(fp.endsWith('.ogg')||fp.endsWith('.mp3'))type='voice';
    else if(fp.endsWith('.jpg'))type='photo';
    else type=ev.media_type;
    this.viewer={open:true,type,path:ev.file_path,
      label:(ev.sender_name||'')+' • '+(ev.type==='deleted'?'بازیابی‌شده 👻':(ev.ttl>0?'TTL '+ev.ttl+'s':'ONE TIME'))};
  },
  closeViewer(){this.viewer.open=false},
  async deleteLog(ev){
    if(!confirm('این مورد برای همیشه حذف شود؟'))return;
    try{await fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:ev.id})})}catch(e){}
    this.logs=this.logs.filter(l=>l.id!==ev.id);
    this.filteredLogs=this.filteredLogs.filter(l=>l.id!==ev.id);
    this.updateCounts();
    this.showToast('حذف شد','🗑️');
    this.fetchStatus();
    if(navigator.vibrate)navigator.vibrate([30,20,30]);
  },
  handleCardClick(ev){const t=ev.content||ev.new_text;if(t&&t.length>150)ev.expanded=!ev.expanded},
  scrollToTop(){this.$refs.feed.scrollTo({top:0,behavior:'smooth'})},
  async clearLogs(){
    if(confirm('تمام تاریخچه پاک شود؟')){
      let filesLeft=-1;
      try{
        const res=await fetch('/api/clear',{method:'POST'});
        const j=await res.json().catch(()=>({}));
        filesLeft=j.filesLeft??-1;
      }catch(e){}
      this.logs=[];this.filteredLogs=[];this.updateCounts();this.filterLogs();
      this.files=[];
      if(filesLeft===0)this.showToast('همه‌چیز پاک شد','🗑️');
      else if(filesLeft>0)this.showToast(filesLeft+' فایل پاک نشد!','⚠️');
      else this.showToast('خطا در پاکسازی','⚠️');
      this.fetchStatus();
      if(navigator.vibrate)navigator.vibrate([50,30,50]);
    }
  },
  showToast(msg,icon){this.toast={show:true,msg,icon};setTimeout(()=>this.toast.show=false,2000)},
  getTypeLabel(t){return{deleted:'DEL',edited:'EDIT',timer_media:'MEDIA'}[t]||t},
  getMediaLabel(t){return{photo:'عکس محرمانه',voice:'ویس',video_note:'ویدیو گرد',video:'ویدیو',audio:'آهنگ',document:'فایل'}[t]||'مدیا'},
}}
</script>
</body>
</html>`
