'use strict';
/**
 * ECOPv 工单系统 · 受控只读同步引擎（服务端模块）
 * =================================================
 * 与 _crm_sync/crm_client.js 同源，四层护栏逐条复刻；本文件**不含任何凭据**。
 *
 * 四层护栏（全部写在代码里，不靠自觉）：
 *   ① ALLOWED_ENDPOINTS 精确匹配白名单，只有 3 个接口
 *   ② FORBIDDEN_HINTS 写操作关键词黑名单，优先级高于白名单（双保险）
 *   ③ 主机锁定：凭据只允许发往配置的那一个域名
 *   ④ 路径归一化：大小写 / 重复斜杠 / URL 编码 / .. 穿越 / 反斜杠，还原后再判定
 *
 * 拦截发生在 fetch **之前** —— 被拦的请求不产生任何网络流量。
 *
 * ⚠️ 绝不允许做的事：
 *   - 不把凭据写进日志（只打掩码）、不写进错误信息、不返回给任何调用方
 *   - 不映射 progressNote / history（工作台人工维护，不可被覆盖）
 */

const crypto = require('crypto');

/* ══════════════════════════════════════════════════════════════════
   ① 只读白名单 —— 写死。要增删接口必须改这里并重跑自测。
   ══════════════════════════════════════════════════════════════════ */
const ALLOWED_ENDPOINTS = Object.freeze([
  Object.freeze({ method: 'POST', path: '/open/auth/token', note: '换取令牌（唯一允许的 POST）' }),
  Object.freeze({ method: 'GET', path: '/sys/getEncryptedString', note: '取 AES 解密密钥' }),
  Object.freeze({ method: 'GET', path: '/work/orderRegister/queryPageList', note: '工单列表（分页只读）' }),
]);

/* ══════════════════════════════════════════════════════════════════
   ② 写操作关键词黑名单 —— 优先级高于白名单
   ══════════════════════════════════════════════════════════════════ */
const FORBIDDEN_HINTS = Object.freeze([
  'add', 'edit', 'import', 'upload', 'delete', 'remove', 'save',
  'update', 'create', 'modify', 'batch', 'login', 'export',
  'reset', 'drop', 'patch', 'insert',
]);

/* ---------------- 路径归一化：防绕过 ---------------- */
function normalizePath(p) {
  let s = String(p == null ? '' : p);
  s = s.split('#')[0].split('?')[0];            // 去 query / hash
  for (let i = 0; i < 3; i++) {                 // 反复解码，防 %2e%2e / %61dd
    try { const d = decodeURIComponent(s); if (d === s) break; s = d; } catch (e) { break; }
  }
  s = s.replace(/\\/g, '/');                    // 反斜杠视作斜杠
  s = s.replace(/\/{2,}/g, '/');                // 折叠重复斜杠
  const parts = [];                             // 解析 . 与 ..
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return '/' + parts.join('/').toLowerCase();
}

/* ---------------- 核心护栏 ---------------- */
function guard(method, rawPath) {
  const m = String(method == null ? '' : method).toUpperCase();
  const p = normalizePath(rawPath);

  if (m !== 'GET' && m !== 'POST') {
    return { ok: false, reason: 'HTTP 方法不允许：' + m + '（只允许 GET / POST）' };
  }
  for (const w of FORBIDDEN_HINTS) {
    if (p.includes(w)) return { ok: false, reason: '命中写操作关键词「' + w + '」' };
  }
  const hit = ALLOWED_ENDPOINTS.find(e => e.method === m && normalizePath(e.path) === p);
  if (!hit) {
    return { ok: false, reason: '不在只读白名单内（白名单只有 ' + ALLOWED_ENDPOINTS.length + ' 个接口）' };
  }
  return { ok: true, endpoint: hit };
}

/* ---------------- 解密（官方 JS 版语义） ---------------- */
function makeDecryptor(key, iv) {
  const kbuf = Buffer.from(String(key), 'utf8');
  const ivbuf = Buffer.from(String(iv), 'utf8');
  const algo = 'aes-' + (kbuf.length * 8) + '-cbc';
  return function decrypt(value) {
    if (typeof value !== 'string' || !value.startsWith('enc:')) return value;
    try {
      const d = crypto.createDecipheriv(algo, kbuf, ivbuf);
      d.setAutoPadding(false);
      const out = Buffer.concat([d.update(Buffer.from(value.slice(4), 'base64')), d.final()]);
      // ⚠️ 官方 JS 版：去尾部 0x00~0x10（文档 Java 示例漏了 0x00，有 bug）
      return out.toString('utf8').replace(/[\u0000-\u0010]+$/g, '');
    } catch (e) { return value; }
  };
}

/* ---------------- 日志脱敏 ---------------- */
/** 只保留首 2 位 + 固定长度掩码，任何情况下都不输出完整凭据 */
function mask(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '(空)';
  return s.slice(0, 2) + '*'.repeat(Math.max(3, Math.min(12, s.length - 2)));
}
/** 从任意对象/字符串中抹掉已知凭据值（用于错误信息兜底） */
function scrub(text, secrets) {
  let s = String(text == null ? '' : text);
  for (const v of secrets || []) {
    if (typeof v === 'string' && v.length >= 6 && s.includes(v)) s = s.split(v).join('***');
  }
  return s;
}

/* ══════════════════════════════════════════════════════════════════
   ③ 字段映射：工单系统 → 工作台（22 字段 / 17 明文 + 5 解密）
   ⚠️ progressNote 与 history 刻意不在此表内 —— 工作台人工维护，红线不可覆盖。
   ══════════════════════════════════════════════════════════════════ */

function toDate(v) {
  if (v === null || v === undefined || v === '') return '';
  const sv = String(v).trim();
  if (/^\d{10,13}$/.test(sv)) {
    const n = Number(sv);
    const ms = sv.length >= 13 ? n : n * 1000;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const m = sv.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return sv;
}
function toRegType(v) {
  if (v === 0 || v === '0') return '首次注册';
  if (v === 1 || v === '1') return '补充注册';
  const s = String(v == null ? '' : v).trim();
  if (/首次/.test(s)) return '首次注册';
  if (/补充/.test(s)) return '补充注册';
  return s;
}
function toRecycling(v) {
  if (v === 1 || v === '1' || v === true || v === 'true') return '含回收';
  if (v === 0 || v === '0' || v === false || v === 'false') return '不含回收';
  return String(v == null ? '' : v).trim();
}
function str(v) { return String(v == null ? '' : v).trim(); }

/* [工作台字段, 来源字段(可多个候选), 是否解密, 转换函数] */
const FIELD_MAP = Object.freeze([
  ['orderNo',        ['workOrderNo', 'orderNo'],            false, str],
  ['status',         ['stateDisplay', 'state_dictText'],    false, str],
  ['orderDate',      ['orderDate'],                         false, toDate],
  ['regType',        ['registerType'],                      false, toRegType],
  ['certNo',         ['regNum'],                            false, str],
  ['customerNo',     ['customerCode'],                      false, str],
  ['companyCn',      ['companyNameCh'],                      true, str],
  ['companyEn',      ['companyNameEn'],                      true, str],
  ['agent',          ['agentUserId_dictText'],               true, str],
  ['directCustomer', ['clientUserId_dictText'],              true, str],
  ['country',        ['countryCode_dictText'],              false, str],
  ['serviceItem',    ['productId_dictText'],                false, str],
  ['firstYear',      ['firstServiceYear'],                  false, str],
  ['serviceStart',   ['serviceStartDate'],                  false, toDate],
  ['serviceEnd',     ['serviceEndDate'],                    false, toDate],
  ['provider',       ['supplierUserId_dictText'],            true, str],
  ['recycling',      ['hasBasicRecycling'],                 false, toRecycling],
  ['rejectReason',   ['rejectReason'],                      false, str],
  ['remark',         ['remark'],                            false, str],
  ['memo',           ['staffRemark'],                       false, str],
  ['createDate',     ['createTime'],                        false, toDate],
]);

/**
 * 把工单系统的一条记录映射成工作台的扁平结构，可直接交给 normalizeOrder()。
 * @param {object} raw  工单系统原始记录
 * @param {Function} decrypt 解密函数（缺失时按明文处理）
 * @returns {object} { orderNo, status, ... }（未知/缺失字段跳过，不清空）
 */
function mapRecord(raw, decrypt) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { history: [] };              // history 恒为空数组：合并时不会覆盖库里的
  for (const [to, froms, needDec, conv] of FIELD_MAP) {
    let v;
    for (const f of froms) {
      const cand = src[f];
      if (cand !== undefined && cand !== null && String(cand) !== '') { v = cand; break; }
    }
    if (v === undefined || v === null) { out[to] = ''; continue; }
    let val = needDec && typeof decrypt === 'function' ? decrypt(v) : v;
    try { val = conv(val); } catch (e) { val = str(val); }
    out[to] = val;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   客户端
   ══════════════════════════════════════════════════════════════════ */
class CrmSync {
  /**
   * @param {object} cfg { baseUrl, clientId, clientKey, clientSecret, pageSize? }
   * @param {object} [opts] { fetchImpl }
   */
  constructor(cfg, opts = {}) {
    const c = cfg || {};
    this.base = String(c.baseUrl || '').replace(/\/+$/, '');
    this._cid = String(c.clientId || '');
    this._ckey = String(c.clientKey || '');
    this._csec = String(c.clientSecret || '');
    this.pageSize = Math.max(10, Math.min(500, Number(c.pageSize) || 200));
    this._fetch = (opts && opts.fetchImpl) || (typeof fetch === 'function' ? fetch : null);
    if (!this.base || !this._cid || !this._ckey || !this._csec) {
      throw new Error('凭据不完整（需要 baseUrl / clientId / clientKey / clientSecret）');
    }
    let bu;
    try { bu = new URL(this.base); } catch (e) { throw new Error('baseUrl 不是合法 URL'); }
    if (bu.protocol !== 'https:' && bu.protocol !== 'http:') throw new Error('baseUrl 协议不支持');
    this._origin = bu.origin;
    this._basePath = bu.pathname.replace(/\/+$/, '');   // 通常是 '/api'
    this._token = null;
    this._tokenExpireAt = 0;
    this._aes = null;
    this.decrypt = null;
    this.stats = { allowed: [], blocked: [] };
    /* 用于 scrub 的敏感值清单（只存在内存） */
    this._secrets = [this._cid, this._ckey, this._csec];
  }

  /** 唯一的网络出口。被拦时在 fetch 之前抛错，不产生任何流量。 */
  async _request(method, pathOrUrl, headers = {}, body = null) {
    const full = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : this.base + pathOrUrl;
    let url;
    try { url = new URL(full); } catch (e) { throw new Error('URL 非法'); }

    // ③ 主机锁定
    if (url.origin !== this._origin) {
      this.stats.blocked.push({ method, path: url.pathname, reason: '非配置主机' });
      const err = new Error('目标主机不是配置的 ECOPv 地址');
      err.code = 'EPR_ENDPOINT_BLOCKED';
      throw err;
    }

    // 换算成「相对 base 的路径」，与白名单同口径
    const bp = this._basePath.toLowerCase();
    const pn = url.pathname;
    let rel;
    if (bp && pn.toLowerCase().startsWith(bp)) rel = pn.slice(this._basePath.length) || '/';
    else if (!bp) rel = pn;
    else rel = null;

    if (rel === null) {
      this.stats.blocked.push({ method, path: pn, reason: '路径不在配置的 base 之下' });
      const err = new Error('路径不在配置的 base 之下');
      err.code = 'EPR_ENDPOINT_BLOCKED';
      throw err;
    }

    const g = guard(method, rel);
    if (!g.ok) {
      this.stats.blocked.push({ method, path: rel, reason: g.reason });
      const err = new Error(g.reason);
      err.code = 'EPR_ENDPOINT_BLOCKED';
      throw err;                      // ← 只到这里，下面的 fetch 永不执行
    }

    this.stats.allowed.push({ method: g.endpoint.method, path: rel });
    if (typeof this._fetch !== 'function') throw new Error('当前运行环境没有 fetch');

    const timeoutMs = 30000;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      return await this._fetch(full, { method: g.endpoint.method, headers, body, signal: ac ? ac.signal : undefined });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _sign(ts) {
    return crypto.createHash('sha256')
      .update(this._cid + ts + this._ckey + this._csec).digest('base64');
  }

  /** ① 换取令牌 */
  async getToken() {
    const ts = String(Date.now());
    const r = await this._request('POST', '/open/auth/token', {
      clientId: this._cid, timestamp: ts, sign: this._sign(ts),
    });
    const j = await r.json();
    if (!j || !j.success) throw new Error('换取令牌失败：' + ((j && j.message) || '未知'));
    this._token = j.result.token;
    this._tokenUser = j.result.username;
    const exp = Number(j.result.expireIn) || 604800;
    this._tokenExpireAt = Date.now() + (exp - 300) * 1000;   // 提前 5 分钟过期
    return this._token;
  }

  async ensureToken() {
    if (!this._token || Date.now() >= this._tokenExpireAt) await this.getToken();
    return this._token;
  }

  /** ② 取解密密钥 */
  async loadAESKey() {
    await this.ensureToken();
    const r = await this._request('GET', '/sys/getEncryptedString',
      { 'X-Access-Token': this._token });
    const j = await r.json();
    const R = j && j.result;
    if (!R) throw new Error('取解密密钥失败');
    if (typeof R === 'string') {
      const p = R.split(/[,;:]/).map(s => s.trim()).filter(Boolean);
      this._aes = { key: p[0], iv: p[1] };
    } else {
      this._aes = { key: R.key || R.aesKey, iv: R.iv || R.aesIv };
    }
    if (!this._aes.key || !this._aes.iv) throw new Error('解密密钥字段缺失');
    this.decrypt = makeDecryptor(this._aes.key, this._aes.iv);
    return { keyLen: String(this._aes.key).length, ivLen: String(this._aes.iv).length };  // 不返回值本身
  }

  /** ③ 只读拉一页工单 */
  async fetchOrderPage(pageNo = 1, pageSize = null) {
    await this.ensureToken();
    const ps = Math.max(10, Math.min(500, Number(pageSize) || this.pageSize));
    const r = await this._request('GET',
      `/work/orderRegister/queryPageList?pageNo=${Number(pageNo)}&pageSize=${ps}`,
      { 'X-Access-Token': this._token });
    const j = await r.json();
    if (!j || !j.success) throw new Error('拉取工单失败：' + ((j && j.message) || '未知'));
    const res = j.result || {};
    const records = res.records || res.list || res.rows || [];
    return {
      records,
      total: Number(res.total) || 0,
      size: Number(res.size) || ps,
      pages: Number(res.pages) || 0,
      current: Number(res.current) || Number(pageNo),
    };
  }

  /**
   * 全量拉取（列表接口没有时间范围过滤 → 只能全量 + 本地比对）
   * @param {object} o { maxPages, onPage }
   */
  async fetchAll(o = {}) {
    const first = await this.fetchOrderPage(1);
    const total = first.total;
    const size = first.size || this.pageSize;
    const totalPages = first.pages || Math.ceil(total / size) || 1;
    const maxPages = Math.max(1, Math.min(2000, Number(o.maxPages) || 2000));
    const pages = Math.min(totalPages, maxPages);
    const records = first.records.slice();
    if (o.onPage) o.onPage(1, pages, records.length, total);
    for (let p = 2; p <= pages; p++) {
      const r = await this.fetchOrderPage(p);
      records.push(...r.records);
      if (o.onPage) o.onPage(p, pages, records.length, total);
      await new Promise(res => setTimeout(res, 120));      // 温和限速，避免触发风控
    }
    return { records, total, pages, fetchedPages: pages };
  }
}

module.exports = {
  CrmSync, guard, normalizePath, makeDecryptor, mapRecord, mask, scrub,
  ALLOWED_ENDPOINTS, FORBIDDEN_HINTS, FIELD_MAP,
};
