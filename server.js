/* ============================================================
   欧洲EPR合规交付工作量控制台 — 轻量后端
   零外部依赖（仅 Node 内置模块）+ 本地 xlsx 包。
   数据存 data.json（共享），凭证存 uploads/，多人协作。
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const XLSX = require('./xlsx.full.min.js');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data.json');
const UPLOADS = path.join(ROOT, 'uploads');
const PORT = process.env.PORT || 3000;
const APP_VERSION = '1.13';  // [由 _tools/version_bump.py 自动维护]
const MAX_BODY = 80 * 1024 * 1024; // 80MB（容纳 base64 凭证）

/* ---------- 工单系统（ECOPv）自动同步 ----------
   凭据隔离设计（三条硬约束）：
     ① 凭据只存在独立的 secrets.json 里，**不在 data.json 内** →
        因此 /api/backup 导出、/api/state 全量下发 都天然带不走它。
     ② secrets.json 不在静态文件白名单（PUBLIC_STATIC）里 → HTTP 永远取不到。
     ③ 凭据永不写入日志（只打掩码）、永不写入任何 HTTP 响应体、永不返回给前端。
   凭据由管理员在「工单导入」页首次填写，服务端运行时才落盘 ——
   不经过任何本地文件、不进发布目录、不进版本库。 */
const SECRETS_FILE = path.join(ROOT, 'secrets.json');
const SYNC_MIN_INTERVAL_MIN = 5;        // 允许的最小同步间隔（分钟）
const SYNC_DEFAULT_INTERVAL_MIN = 30;   // 默认同步间隔（分钟）
function loadSecrets(){
  try {
    if (!fs.existsSync(SECRETS_FILE)) return null;
    const s = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    if (!s || typeof s !== 'object') return null;
    const c = s.ecopv || {};
    if (!c.baseUrl || !c.clientId || !c.clientKey || !c.clientSecret) return null;
    return {
      ecopv: {
        baseUrl: String(c.baseUrl),
        clientId: String(c.clientId),
        clientKey: String(c.clientKey),
        clientSecret: String(c.clientSecret),
        pageSize: Math.max(10, Math.min(500, Number(c.pageSize) || 200))
      },
      intervalMinutes: Math.max(SYNC_MIN_INTERVAL_MIN, Number(s.intervalMinutes) || SYNC_DEFAULT_INTERVAL_MIN),
      enabled: s.enabled !== false
    };
  } catch (e) { return null; }
}
function saveSecrets(obj){
  const tmp = SECRETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
}
/* 同步运行状态（**只放非敏感信息**，可安全返回给管理员） */
let SYNC_STATE = {
  enabled: false, running: false,
  lastRunAt: null, lastTrigger: null, lastResult: null, lastError: null,
  nextRunAt: null, consecutiveFailures: 0, lastDurationMs: null
};
let _syncTimer = null;
let CRMSYNC = null;
try { CRMSYNC = require('./crm_sync.js'); } catch (e) { CRMSYNC = null; }

/* ---------- 进程稳定性加固 ---------- */
// 任何未捕获异常 / Promise 拒绝都只记录，不让进程退出（避免单点错误导致服务整体崩溃）
process.on('uncaughtException', (e) => { console.error('[未捕获异常，已忽略]', (e && e.stack) || e); });
process.on('unhandledRejection', (e) => { console.error('[未处理的 Promise 拒绝，已忽略]', (e && e.stack) || e); });

// 登录会话持久化：存到 sessions.json，服务重启后登录态不丢失，避免“又要重新登录”
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');
function loadSessions(){
  try { const s = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); return new Map(Object.entries(s || {})); }
  catch (e) { return new Map(); }
}
function saveSessions(){
  try { const o = {}; for (const [k, v] of sessions) o[k] = v; fs.writeFileSync(SESSIONS_FILE, JSON.stringify(o)); }
  catch (e) { console.error('写会话文件失败', e); }
}

/* ---------- 危险操作审计 ----------
   所有"覆盖/清空/导入/改全局配置"类操作都追加写入 audit.log（一行一条 JSON），
   出现"数据怎么没了"时可直接查是谁、何时、用了哪个接口。审计失败不影响主流程。 */
const AUDIT_FILE = path.join(ROOT, 'audit.log');
function audit(user, action, detail){
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({
      time: new Date().toISOString(),
      user: user ? (user.username + '/' + user.displayName) : 'anonymous',
      action, detail: detail || ''
    }) + '\n');
  } catch (e) { console.error('写审计日志失败', e); }
}

/* ---------- 数据自动快照（防清空 / 防误覆盖，可一键回滚） ----------
   背景：曾发生过"工单从 1.7 万变成 0 条"的事故（误点清空 / 重发覆盖）。
   这里做三层保险：
   1) 每次执行「覆盖型」操作（seed / reset / restore）之前，先自动存一份当前数据快照；
   2) 运行期间每 BACKUP_MIN_GAP_MS 至少自动留档一份（gzip 压缩，体积约为原文件 1/10）；
   3) 启动时若发现工单为空但存在非空快照 → 自动从最近快照恢复（避免"打开就是 0 条"）。
   快照存放：backups/data-YYYYMMDD-HHmmss.json.gz，另附 backups/index.json 记录索引。 */
const BACKUP_DIR = path.join(ROOT, 'backups');
const BACKUP_INDEX = path.join(BACKUP_DIR, 'index.json');
const RESET_MARKER = path.join(ROOT, '.last-reset');   // 记录最近一次"显式清空"时间，供启动自愈判断
const BACKUP_KEEP = 20;                    // 最多保留份数（超出删最旧）
const BACKUP_MIN_GAP_MS = 30 * 60 * 1000;  // 运行期自动留档的最小间隔：30 分钟
let _lastAutoBackup = 0;

function ensureBackupDir(){
  try { if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
}
function readBackupIndex(){
  try { const a = JSON.parse(fs.readFileSync(BACKUP_INDEX, 'utf8')); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function writeBackupIndex(arr){ try { fs.writeFileSync(BACKUP_INDEX, JSON.stringify(arr, null, 2)); } catch (e) {} }
function stampName(){
  const t = new Date(), p = n => String(n).padStart(2, '0');
  return 'data-' + t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '-' +
         p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds()) + '.json.gz';
}
/* 写一份快照。tag 只用于日志/审计，不参与文件名（便于按时间排序）。 */
function writeSnapshot(tag){
  try {
    const src = DB || _pendingData;
    if (!src || !Array.isArray(src.workOrders)) return null;
    ensureBackupDir();
    const raw = JSON.stringify(src, null, 2);
    let name = stampName(), n = 1;
    // 同一秒内可能连写两份（如 reset 前的底档 + restore 前的底档），避免重名互相覆盖
    while (fs.existsSync(path.join(BACKUP_DIR, name))) {
      name = stampName().replace(/\.json\.gz$/, '-' + (n++) + '.json.gz');
    }
    fs.writeFileSync(path.join(BACKUP_DIR, name), zlib.gzipSync(Buffer.from(raw, 'utf8'), { level: 6 }));
    const idx = readBackupIndex();
    idx.push({
      name, time: new Date().toISOString(), tag: tag || 'auto',
      orders: src.workOrders.length, daily: (src.daily || []).length,
      users: (src.users || []).length, bytes: raw.length
    });
    idx.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const keep = idx.slice(-BACKUP_KEEP), drop = idx.slice(0, Math.max(0, idx.length - BACKUP_KEEP));
    drop.forEach(d => { try { fs.unlinkSync(path.join(BACKUP_DIR, d.name)); } catch (e) {} });
    writeBackupIndex(keep);
    _lastAutoBackup = Date.now();
    console.log('[快照] ' + name + '（工单 ' + src.workOrders.length + ' 条，' + (tag || 'auto') + '）');
    return name;
  } catch (e) { console.error('写快照失败', e); return null; }
}
/* 运行期定期留档：由落盘成功后调用，未到间隔就跳过 */
function maybeAutoSnapshot(){
  if (Date.now() - _lastAutoBackup < BACKUP_MIN_GAP_MS) return;
  if (!DB || !DB.workOrders || !DB.workOrders.length) return; // 空库不留档（避免把"0 条"存成快照）
  writeSnapshot('auto');
}
function listBackups(){
  const idx = readBackupIndex();
  return idx.map(e => {
    let size = 0; try { size = fs.statSync(path.join(BACKUP_DIR, e.name)).size; } catch (err) {}
    return Object.assign({}, e, { gzBytes: size });
  }).filter(e => e.gzBytes > 0);
}
/* 启动自愈：data.json 工单为空、但存在非空快照时，自动恢复最近一份 */
function autoHealIfEmpty(){
  try {
    if (!DB || (Array.isArray(DB.workOrders) && DB.workOrders.length > 0)) return;
    const cands = listBackups().filter(e => e.orders > 0)
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    if (!cands.length) return;
    // 若最近一次"清空"是管理员显式操作（晚于最新快照），说明是有意清空，不自动复活
    try {
      const m = fs.readFileSync(RESET_MARKER, 'utf8').trim();
      if (m && m > String(cands[0].time)) { console.log('[自愈] 检测到管理员显式清空记录，跳过自动恢复'); return; }
    } catch (e) { /* 无标记文件，正常继续 */ }
    const name = cands[0].name;
    const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(BACKUP_DIR, name))).toString('utf8'));
    if (!Array.isArray(snap.workOrders) || !snap.workOrders.length) return;
    // 账号沿用当前库，避免把历史密码/会话状态一起回滚
    if (DB && Array.isArray(DB.users) && DB.users.length) snap.users = DB.users;
    DB = snap;
    fs.writeFileSync(DATA + '.tmp', JSON.stringify(DB, null, 2));
    fs.renameSync(DATA + '.tmp', DATA);
    audit(null, 'auto-restore', '启动时检测到工单为 0，已自动从快照 ' + name + ' 恢复 ' + DB.workOrders.length + ' 条');
    console.log('[自愈] 检测到工单为空，已从快照 ' + name + ' 自动恢复 ' + DB.workOrders.length + ' 条工单');
  } catch (e) { console.error('启动自愈失败', e); }
}

/* ---------- 数据模型常量（与前端一致） ---------- */
const HEADER_MAP = {
  '状态':'status','下单日期':'orderDate','注册类型':'regType','主工单编号':'orderNo','证书号':'certNo',
  '客户号':'customerNo','公司中文名称':'companyCn','公司英文名称':'companyEn','所属代理':'agent',
  '所属直客':'directCustomer','国家':'country','服务项目':'serviceItem','首年服务':'firstYear',
  '服务开始日期':'serviceStart','服务结束日期':'serviceEnd','服务商':'provider','基础回收':'recycling',
  '驳回原因':'rejectReason','最新交付进度':'progressNote','备注':'remark','备忘':'memo','创建日期':'createDate'
};
const GENERIC_STEPS = ['提交资料','官方审核','下发证书'];

/* 注册「每步 1 分」：业务上就是完成一步记一分，与「工作类型及点数」里的配置无关。
   （只有「申报」和「其他工作」才按配置里各类类型的点数记分。） */
const REG_STEP_POINTS = 1;
const DEFAULT_WORKTYPES = [
  {id:'wt_reg',name:'注册协助',points:1,builtin:true},
  {id:'wt_dec',name:'申报协助',points:1,builtin:true},
  {id:'wt_file',name:'文件整理',points:5,builtin:true},
  {id:'wt_areg',name:'异常注册跟进',points:4,builtin:true},
  {id:'wt_adec',name:'异常申报跟进',points:4,builtin:true},
  {id:'wt_abill',name:'异常账单跟进',points:4,builtin:true},
  {id:'wt_pro',name:'PRO邮件沟通',points:4,builtin:true},
  {id:'wt_sop',name:'SOP文件制作',points:5,builtin:true},
  {id:'wt_audit',name:'文件审核',points:4,builtin:true},
  {id:'wt_cross',name:'跨国家协助工作',points:7,builtin:true}
];

/* ---------- 数据存取 ---------- */
/* 仅在「首次运行 / 整库重置」时用于建初始库的默认账号。
   ⚠️ 这里原本还有 zhangming(张明) / liting(李婷) / wanghao(王浩) 三个示例专员账号，
   已按要求移除：它们是示例数据，且会被 loadDB() 在每次启动时自动补回，
   导致管理员删除后一重启就复活（新 id + 默认密码 123456）。 */
const SEED_USERS = [
  ['admin','系统管理员','admin','admin123']
];
function loadDB(){
  let d = null;
  if (fs.existsSync(DATA)) {
    try { d = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { console.error('读取 data.json 失败，重建', e); d = null; }
  }
  if (!d || !Array.isArray(d.users)) { d = initDB(); saveDB(d); return d; }
  // ⚠️ 此处原为「幂等补全」：启动时把 SEED_USERS 中缺失的默认账号自动补回并写盘。
  // 已按需求移除 —— 它会让管理员明确删除的账号在每次重启（含平台重启、含重发）后
  // 以新 id + 默认密码重新出现，删除操作实际无效。
  // 现策略：账号**完全以 data.json 为准**，服务端不再自动新增任何账号。
  let changed = false;
  // 唯一的兜底（极窄）：仅当账号列表被**完全清空**时才补建一个默认管理员，
  // 避免出现"连管理员都登不进去、只能手工改 data.json"的死局。
  // 注意：账号列表非空时，服务端绝不新增任何账号 —— 管理员删掉的账号不会复活。
  if (!d.users.length) {
    console.warn('[账号] data.json 中 users 为空，已补建默认管理员 admin / admin123');
    d.users.push(makeUser('admin', '系统管理员', 'admin', 'admin123'));
    changed = true;
  }
  // 确保 config 关键字段存在（兼容旧版 data.json 缺 weights）
  if (!d.config) d.config = {};
  if (!d.config.weights) d.config.weights = {};
  if (!d.config.managers) d.config.managers = {};
  if (!d.config.steps) d.config.steps = {};
  if (!d.config.workTypes || !d.config.workTypes.length) d.config.workTypes = DEFAULT_WORKTYPES.map(w=>({...w}));
  // 补齐系统工作类型 id（注册=wt_reg / 申报=wt_dec），详见 ensureSysWorkTypes 注释
  if (ensureSysWorkTypes(d)) changed = true;
  if (changed) saveDB(d);
  return d;
}
/* 系统工作类型自愈：代码里写死「注册=wt_reg、申报=wt_dec」两个 id。
   线上曾把「申报协助」建成随机 id（wt_17xxxxxxxxx），导致申报记 0 分、录入明细里
   显示的是一串 id 而不是中文名。这里在启动时把这两个 id 补齐：
   ① 已经存在同名 id → 不动；
   ② 不存在，但有名称精确匹配「注册协助/注册交付…」「申报协助/申报处理…」的类型 → 就地改 id（保留其点数与顺序）；
   ③ 都没有 → 新建一个（注册协助 1 分 / 申报协助 1 分）。
   只在 id 缺失时触发，所以是幂等的，也不会动用户的自定义类型。 */
const SYS_WORKTYPE_ALIAS = {
  wt_reg: ['注册协助','注册交付','注册处理'],
  wt_dec: ['申报协助','申报处理','申报交付']
};
function ensureSysWorkTypes(d){
  if (!d || !d.config) return false;
  const wt = d.config.workTypes = d.config.workTypes || [];
  let changed = false;
  for (const id of Object.keys(SYS_WORKTYPE_ALIAS)) {
    if (wt.some(x => x.id === id)) continue;
    const names = SYS_WORKTYPE_ALIAS[id];
    const hit = wt.find(x => names.includes(String(x.name == null ? '' : x.name).trim()));
    if (hit) { hit.id = id; if (!hit.builtin) hit.builtin = true; }
    else wt.push({ id, name: id === 'wt_reg' ? '注册协助' : '申报协助', points: 1, builtin: true });
    changed = true;
    console.log('[工作类型] 已补齐系统类型 ' + id + '（' + (hit ? '改名自「' + hit.name + '」' : '新建') + '）');
  }
  return changed;
}
/* 大文件落盘优化：合并连续写入 + 异步写 + 临时文件原子替换
   工单量大时（data.json 可达 20MB+），若每次操作都同步写盘会明显阻塞请求。
   这里改为：延迟 SAVE_DEBOUNCE_MS 后异步写入，期间的新写入会被合并为最后一次。 */
const SAVE_DEBOUNCE_MS = 200;
let _saveTimer = null, _saving = false, _pending = false, _pendingData = null;
function saveDB(d){
  _pendingData = d || DB;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushDB, SAVE_DEBOUNCE_MS);
}
function flushDB(){
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const data = _pendingData || DB;
  _pendingData = null;
  if (!data) return;
  if (_saving) { _pending = true; _pendingData = data; return; }
  _saving = true;
  let text;
  try { text = JSON.stringify(data, null, 2); }
  catch (e) { _saving = false; console.error('序列化失败，未写盘', e); return; }
  const tmp = DATA + '.tmp';
  fs.writeFile(tmp, text, (err) => {
    if (err) { _saving = false; console.error('写盘失败', err); scheduleRetry(); return; }
    fs.rename(tmp, DATA, (err2) => {
      _saving = false;
      if (err2) console.error('落盘替换失败', err2);
      else { try { maybeAutoSnapshot(); } catch (e) { console.error('自动留档失败', e); } }
      if (_pending) { _pending = false; scheduleRetry(); }
    });
  });
}
function scheduleRetry(){ setTimeout(flushDB, 0); }
// 进程退出前把未落盘的数据补齐，避免丢失
process.on('SIGINT', () => { flushDBSync(); process.exit(0); });
process.on('SIGTERM', () => { flushDBSync(); process.exit(0); });
process.on('beforeExit', () => { flushDBSync(); });
function flushDBSync(){
  if (_saving) return; // 已有异步写在飞，避免同时写同一个临时文件
  const data = _pendingData || DB;
  if (!data) return;
  try {
    fs.writeFileSync(DATA + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(DATA + '.tmp', DATA);
    _pendingData = null;
  } catch (e) { console.error('退出前落盘失败', e); }
}
/* 关键写操作（导入 / 清空 / 录步骤 / 其他工作）用这个：先落盘再返回。
   原来的 saveDB 有 200ms 防抖，若响应发出后进程在窗口内被回收（平台重启/缩容），
   那次写入就丢了 —— 表现就是"提示保存成功，刷新后没了"。 */
function saveDBNow(d){
  _pendingData = d || DB;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  flushDBSync();
  if (_pendingData) saveDB(DB);   // 若正有异步写在飞，flushDBSync 会跳过，这里再排一次兜底
}
function initDB(){
  const d = {
    users: [],
    config: { managers: {}, workTypes: DEFAULT_WORKTYPES.map(w=>({...w})), steps: {}, weights: {} },
    workOrders: [],
    daily: []
  };
  SEED_USERS.forEach(([u, name, role, pw]) => d.users.push(makeUser(u, name, role, pw)));
  return d;
}
let DB = loadDB();
// 启动自愈（工单为 0 时从最近快照恢复）+ 首次运行先留一份底档
autoHealIfEmpty();
try { if (!listBackups().length) writeSnapshot('startup'); } catch (e) { console.error('启动留档失败', e); }
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------- 密码 / 会话 ---------- */
function hashPw(pw, salt){ return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function makeUser(username, displayName, role, pw){
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: 'u' + crypto.randomBytes(6).toString('hex'), username, displayName, role, salt, passwordHash: hashPw(pw, salt), lastLogin: null };
}
function verifyUser(username, pw){
  const u = DB.users.find(x => x.username === username);
  if (!u) return null;
  if (hashPw(pw, u.salt) !== u.passwordHash) return null;
  return u;
}
const sessions = loadSessions(); // token -> userId（从磁盘加载，重启不丢）
function newToken(){ return crypto.randomBytes(24).toString('hex'); }

/* ---------- 角色 ----------
   root（最高）> admin > specialist。
   · root 拥有 admin 的**全部**权限；
   · root **唯一额外能力** = 查看工单系统凭据明文（且必须二次验证登录密码）；
   · admin **永远看不到**凭据明文（调该接口一律 403）。
   注意：凡是「管理员可见/可操作」的判断，一律用 isAdminLike()，不能写 user.role==='admin'，
   否则 root 会被自己的账号挡住。 */
function isAdminLike(u){ return !!u && (u.role === 'admin' || u.role === 'root'); }
function isRoot(u){ return !!u && u.role === 'root'; }
function normRole(r){
  if (r === 'root') return 'root';
  if (r === 'admin') return 'admin';
  return 'specialist';
}

/* ---------- Excel 解析 ---------- */
function mapRows(rows){
  return rows.map(raw => {
    /* 先清理表头：去掉 BOM(\uFEFF) 与首尾空白。
       Excel「另存为 CSV UTF-8」会写 BOM，BOM 会粘在第一列列名上（"﻿状态" → "\uFEFF状态"），
       导致该列匹配不上 HEADER_MAP 而被**静默丢弃** —— 状态列一旦丢失会退回默认值，
       可能把「已下证」的工单改回「待提交」。 */
    const r = {};
    for (const k of Object.keys(raw)) r[String(k).replace(/^\uFEFF/, '').trim()] = raw[k];
    const o = {};
    for (const [zh, key] of Object.entries(HEADER_MAP)) {
      const v = r[zh];
      if (v !== undefined && v !== null && String(v).trim() !== '') o[key] = v;
    }
    if (!Object.keys(o).length) {
      for (const k of Object.keys(r)) {
        const m = Object.entries(HEADER_MAP).find(([zh]) => zh.toLowerCase() === String(k).toLowerCase());
        if (m && r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') o[m[1]] = r[k];
      }
    }
    return o;
  }).filter(o => o.orderNo);
}
function normalizeOrder(r){
  return {
    orderNo: String(r.orderNo || '').trim(),
    // 注意：**不**默认成 '待提交'。文件没给状态（缺列/该行为空）时留空，
    //       由 mergeImportedOrder 判定"文件没表态 → 不动库里的状态"，避免误把状态改坏。
    //       同时做规范化（trim），否则 "已下证 " 这种带空格的变体会被当成另一个状态值。
    status: normStatus(r.status),
    orderDate: r.orderDate || '', regType: r.regType || '', certNo: r.certNo || '',
    customerNo: r.customerNo || '', companyCn: r.companyCn || '', companyEn: r.companyEn || '',
    agent: r.agent || '', directCustomer: r.directCustomer || '', country: r.country || '',
    serviceItem: r.serviceItem || '', firstYear: r.firstYear || '', serviceStart: r.serviceStart || '',
    serviceEnd: r.serviceEnd || '', provider: r.provider || '', recycling: r.recycling || '',
    rejectReason: r.rejectReason || '', progressNote: r.progressNote || '', remark: r.remark || '',
    memo: r.memo || '', createDate: r.createDate || '', history: []
  };
}
/* 导入时的「安全覆盖」合并规则（原先是用 Object.assign 整条覆盖，会把已录进度一起抹掉）：
   - 资料字段（客户名 / 国家 / 日期 / 证书号 …）：以导入文件为准；文件里为空的字段**不清空**库里的值
   - 系统字段（history 步骤历史 / progressNote 最新交付进度）：**永远保留库里的值**，绝不被文件覆盖
   - status：库里尚未录入过进度时按文件更新（支持"未下证 → 已下证"这类扭转）；
             库里已有录入进度时只允许「进步」，不允许因导入把工单打回未下证
             （文件给出 已撤单/已注销/已驳回 等终态时仍以文件为准） */
const PROGRESS_STATUS = ['待提交','待注册','注册中','待下证','已下证'];
/* 业务上真实在用的「非进度终态」（实测线上 data.json 的状态取值全集里，除进度态之外的 6 种）。
   白名单的意义：把"合法的终态"和"打错的乱值"区分开 —— 两者 progressRank 都是 -1，
   若不区分，Excel 里一个手误（如"已下证 "多一个空格、"已完成"）就会把工单状态写成无法识别的乱值，
   导致该单在状态筛选 / 报表 / 看板里"消失"。 */
const TERMINAL_STATUS = ['已撤单','已注销','注销中','已驳回','待审核','转走/撤单'];
/* 「待审核」虽在合法白名单内，但它是工单系统的**流程前置态**（工单刚提交、还没轮到处理），
   不代表工作台的交付进度。若允许它覆盖，同事已经做到「注册中 / 已下证」的工单
   会被同步打回「待审核」——属于灾难级回退。
   因此它**只用于新建工单建档，绝不用于回退已有工单**。 */
const PRE_ONLY_STATUS = ['待审核'];
const KNOWN_STATUS = PROGRESS_STATUS.concat(TERMINAL_STATUS);
const IMPORT_SYS_FIELDS = ['history','progressNote'];
function progressRank(s){ return PROGRESS_STATUS.indexOf(s); }
function isKnownStatus(s){ return KNOWN_STATUS.indexOf(s) >= 0; }
/* 状态值规范化：去首尾空白（含全角空格）。Excel 单元格里粘进来常带尾空格，
   "已下证 " ≠ "已下证"，不 trim 就会静默变成另一个状态值。 */
function normStatus(s){
  if (s === null || s === undefined) return '';
  return String(s).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}
function mergeImportedOrder(prev, norm, onFlag){
  const prevHistory = Array.isArray(prev.history) ? prev.history : [];
  const hasProgress = prevHistory.length > 0;
  let statusProtected = false;
  for (const k of Object.keys(norm)) {
    if (IMPORT_SYS_FIELDS.includes(k) || k === 'status') continue;
    const v = norm[k];
    if (v === '' || v === null || v === undefined) continue;   // 文件里为空 → 保留库里已有值
    prev[k] = v;
  }
  const src = norm.status;
  if (!src) {
    /* 文件没有给状态（缺"状态"列 / 该行为空）→ 视为"文件没表态"，**保持库里的状态不动**。
       否则会被默认值"待提交"把已下证的工单打回未下证。 */
  } else if (!isKnownStatus(src)) {
    /* 文件给了一个系统不认识的状态值（打错 / 加了备注 / 是带空格的变体）→ 一律**不动库里的状态**，
       并回执计数，让用户知道有几行状态被忽略了。宁可不动，也不写进一个无法识别的乱值。 */
    if (onFlag) onFlag('unknown');
  } else if (!hasProgress) {
    prev.status = src;
  } else {
    const rs = progressRank(src), rp = progressRank(prev.status);
    if (rs < 0 && PRE_ONLY_STATUS.includes(src)) {
      /* 前置态（待审核）：只允许新建时使用，对已有工单一律不动 → 计入"状态受保护" */
      statusProtected = true;
    } else if (rs < 0) prev.status = src;      // 真终态（已撤单/已注销/已驳回/转走撤单…）→ 以文件为准
    else if (rs > rp) prev.status = src;       // 进度前进 → 以文件为准
    else statusProtected = true;               // 会回退 → 保护库里状态
  }
  if (hasProgress) {
    prev.history = prevHistory;                // 步骤历史原样保留
    if (onFlag) onFlag('progress');
  }
  if (!prev.progressNote && norm.progressNote) prev.progressNote = norm.progressNote;
  if (statusProtected && onFlag) onFlag('status');
  return prev;
}
/* 把一批「已映射成工作台扁平结构」的记录合并进 DB。
   手工 Excel 导入（/api/import）与工单系统自动同步（runSync）**共用这一个函数** ——
   合并语义只有一份实现，杜绝两条路径行为漂移。 */
function applyMappedOrders(mapped){
  const idx = new Map();
  for (let i = 0; i < DB.workOrders.length; i++) {
    const o = DB.workOrders[i];
    if (o && o.orderNo != null) idx.set(String(o.orderNo), i);
  }
  let added = 0, updated = 0, keptProgress = 0, protectedStatus = 0, unknownStatus = 0;
  for (const r of mapped) {
    const norm = normalizeOrder(r);
    if (!norm.orderNo) continue;
    const key = String(norm.orderNo);
    const pos = idx.get(key);
    if (pos !== undefined) {
      mergeImportedOrder(DB.workOrders[pos], norm, (flag) => {
        if (flag === 'progress') keptProgress++;
        if (flag === 'status') protectedStatus++;
        if (flag === 'unknown') unknownStatus++;
      });
      updated++;
    } else {
      // 新增工单：库里原本没有 → 必须给一个合法状态建档
      if (!norm.status || !isKnownStatus(norm.status)) {
        if (norm.status) unknownStatus++;
        norm.status = '待提交';
      }
      idx.set(key, DB.workOrders.length);
      DB.workOrders.push(norm);
      added++;
    }
  }
  new Set(DB.workOrders.map(o => stepKey(o.country, o.serviceItem))).forEach(k => {
    if (!DB.config.steps[k]) DB.config.steps[k] = GENERIC_STEPS.slice();
  });
  return { added, updated, total: mapped.length, keptProgress, protectedStatus, unknownStatus, ordersNow: DB.workOrders.length };
}
function parseXlsxBuffer(buf, filename){
  let rows;
  if (/\.csv$/i.test(filename || '')) {
    // CSV：以文本方式解析，避免被当二进制 xlsx 导致中文表头乱码、匹配不到字段
    const text = buf.toString('utf8');
    const wb = XLSX.read(text, { type: 'string', raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } else {
    const wb = XLSX.read(buf, { type: 'buffer', raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  }
  return mapRows(rows);
}

/* ---------- 业务辅助 ---------- */
function workTypePoints(typeId){
  const w = DB.config.workTypes.find(x => x.id === typeId);
  return w ? w.points : 0;
}
function stepKey(c, s){ return c + '|' + s; }
function getSteps(c, s){ return DB.config.steps[stepKey(c, s)] || GENERIC_STEPS; }

/* ---------- HTTP 工具 ---------- */
let _currentReq = null; // 当前请求对象，供 send() 判断是否支持 gzip
function send(res, code, obj, req){
  const body = Buffer.from(JSON.stringify(obj));
  /* 性能：大响应（如 /api/state 的 21.5MB）自动 gzip，传输量约降到 1/10 */
  const r = req || _currentReq;
  const acceptGzip = r && /gzip/.test(r.headers['accept-encoding'] || '');
  if (acceptGzip && body.length > 10240) {
    const gz = zlib.gzipSync(body, { level: 6 });
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Content-Encoding': 'gzip',
      'Content-Length': gz.length
    });
    res.end(gz);
  } else {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  }
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
/* 取出请求里所有可能的登录令牌，按可信度排序。
   注意：部署到带网关的云环境时，网关会自行注入一个 Authorization: Bearer <JWT>，
   把前端带来的令牌顶掉。所以应用自己的 X-Auth-Token 优先级最高。 */
function tokenCandidates(req){
  const out = [];
  const x = req.headers['x-auth-token'];
  if (x) { const v = String(x).trim(); if (v) out.push(v); }
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) { const v = h.slice(7).trim(); if (v) out.push(v); }
  return out;
}
function sessionUser(t){
  if (!t) return null;
  let uid = sessions.get(t);
  // 多实例 / 进程被回收的场景：内存里查不到时，回读磁盘会话文件再试一次
  if (!uid) {
    try {
      const disk = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {};
      if (disk[t]) { uid = disk[t]; sessions.set(t, uid); }
    } catch (e) { /* 忽略，按未登录处理 */ }
  }
  if (!uid) return null;
  return DB.users.find(u => u.id === uid) || null;
}
function getUser(req){
  for (const t of tokenCandidates(req)) {
    const u = sessionUser(t);
    if (u) return u;
  }
  return null;
}

/* ---------- 静态文件 ---------- */
/* .doc/.docx/.xls/.xlsx 等文档类型一并补上：凭证现在支持任意类型文件上传，
   缺 MIME 时会被当成 octet-stream（虽仍能下载，但类型信息丢失）。 */
const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.pdf':'application/pdf', '.doc':'application/msword', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls':'application/vnd.ms-excel', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip':'application/zip', '.txt':'text/plain; charset=utf-8', '.csv':'text/csv; charset=utf-8' };
/* 静态资源白名单：只有真正需要发给浏览器的文件才可访问。
   ⚠ 安全修复：此前 serveStatic 会照发项目根目录下任何文件，导致
   data.json（全量客户工单）、sessions.json（登录令牌）、server.js、package.json
   都能被"未登录"直接下载。现改为白名单，其余一律 404。 */
const PUBLIC_STATIC = new Set(['/index.html', '/xlsx.full.min.js', '/favicon.ico']);
function serveStatic(req, res, urlPath){
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (!PUBLIC_STATIC.has(rel) && !rel.startsWith('/uploads/')) { res.writeHead(404); res.end('not found'); return; }
  // 只允许项目内已知文件，防遍历
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full).toLowerCase();
    // 禁止浏览器缓存页面与脚本，避免前端改完仍显示旧版本（局域网多人协作频繁改版）
    const cache = (ext === '.html' || ext === '.js') ? { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' } : {};
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream' }, cache));
    res.end(data);
  });
}

/* ---------- 工单系统自动同步：执行器 ---------- */
/* 返回给管理员的同步状态：**只含非敏感信息**。
   凭据一律不出现 —— 连掩码都不返回（用户 2026-10-13 明确要求：
   界面与接口都不显示 clientId 的任何片段，彻底断掉泄露面）。 */
function syncPublicStatus(){
  const cfg = loadSecrets();
  const c = cfg ? cfg.ecopv : null;
  return {
    moduleReady: !!CRMSYNC,
    configured: !!cfg,
    enabled: !!(cfg && cfg.enabled),
    intervalMinutes: cfg ? cfg.intervalMinutes : null,
    minIntervalMinutes: SYNC_MIN_INTERVAL_MIN,
    baseUrl: c ? c.baseUrl : null,
    hasClientId: !!(c && c.clientId),          // 只回"有没有"，不回任何内容
    running: SYNC_STATE.running,
    lastRunAt: SYNC_STATE.lastRunAt,
    lastTrigger: SYNC_STATE.lastTrigger,
    lastResult: SYNC_STATE.lastResult,
    lastError: SYNC_STATE.lastError,
    lastDurationMs: SYNC_STATE.lastDurationMs,
    nextRunAt: SYNC_STATE.nextRunAt,
    consecutiveFailures: SYNC_STATE.consecutiveFailures
  };
}
function computeNextRun(){
  const cfg = loadSecrets();
  if (!cfg || !cfg.enabled) { SYNC_STATE.nextRunAt = null; return; }
  SYNC_STATE.nextRunAt = new Date(Date.now() + cfg.intervalMinutes * 60000).toISOString();
}
/* 执行一次同步。全程只读（白名单只放行 3 个只读接口），
   合并走与手工导入完全相同的 applyMappedOrders()。 */
async function runSync(trigger){
  if (!CRMSYNC) return { ok: false, error: '同步模块未加载' };
  if (SYNC_STATE.running) return { ok: false, error: '同步正在进行中，请稍候' };
  const cfg = loadSecrets();
  if (!cfg) return { ok: false, error: '尚未配置工单系统凭据' };
  if (trigger === 'auto' && !cfg.enabled) return { ok: false, error: '自动同步已关闭' };

  SYNC_STATE.running = true;
  SYNC_STATE.lastError = null;
  const t0 = Date.now();
  const secretsForScrub = [cfg.ecopv.clientId, cfg.ecopv.clientKey, cfg.ecopv.clientSecret];
  const cli = new CRMSYNC.CrmSync(cfg.ecopv);
  try {
    await cli.getToken();
    await cli.loadAESKey();
    const all = await cli.fetchAll({});
    const mapped = [];
    let skipped = 0;
    for (const rec of all.records) {
      const m = CRMSYNC.mapRecord(rec, cli.decrypt);
      if (!m.orderNo) { skipped++; continue; }
      mapped.push(m);
    }
    const st = applyMappedOrders(mapped);
    if (st.added || st.updated) saveDBNow(DB);     // 只在真有差异时落盘
    SYNC_STATE.lastResult = Object.assign({}, st, {
      fetched: all.records.length, remoteTotal: all.total, skipped, pages: all.fetchedPages
    });
    SYNC_STATE.lastRunAt = new Date().toISOString();
    SYNC_STATE.lastTrigger = trigger;
    SYNC_STATE.lastDurationMs = Date.now() - t0;
    SYNC_STATE.consecutiveFailures = 0;
    computeNextRun();
    audit(null, 'sync', '工单系统同步(' + trigger + ')：拉取=' + all.records.length + ' 新增=' + st.added
      + ' 更新=' + st.updated + ' 保留进度=' + st.keptProgress + ' 保护状态=' + st.protectedStatus
      + ' 状态未识别=' + st.unknownStatus);
    return { ok: true, result: SYNC_STATE.lastResult };
  } catch (e) {
    // 错误信息一律 scrub 掉凭据（防止某些库把请求头拼进错误文本）
    const raw = (e && e.message) ? e.message : String(e);
    const msg = CRMSYNC.scrub(raw, secretsForScrub);
    SYNC_STATE.lastError = msg;
    SYNC_STATE.lastRunAt = new Date().toISOString();
    SYNC_STATE.lastTrigger = trigger;
    SYNC_STATE.lastDurationMs = Date.now() - t0;
    SYNC_STATE.consecutiveFailures = (SYNC_STATE.consecutiveFailures || 0) + 1;
    computeNextRun();
    console.error('[sync] 同步失败：' + msg);   // msg 已 scrub，不含凭据
    return { ok: false, error: msg };
  } finally {
    SYNC_STATE.running = false;
  }
}
/* 定时器：间隔取自 secrets.json（改配置调用 startSyncTimer() 即刻生效，无需重启） */
function startSyncTimer(){
  if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
  const cfg = loadSecrets();
  SYNC_STATE.enabled = !!(cfg && cfg.enabled);
  if (!cfg || !cfg.enabled) { SYNC_STATE.nextRunAt = null; return; }
  const ms = cfg.intervalMinutes * 60000;
  computeNextRun();
  _syncTimer = setInterval(() => { runSync('auto').catch(() => {}); }, ms);
  if (_syncTimer.unref) _syncTimer.unref();     // 不阻止进程正常退出
  console.log('[sync] 自动同步已启用：每 ' + cfg.intervalMinutes + ' 分钟一次（只读）');
}

/* ---------- API 路由 ---------- */
async function handleApi(req, res, pathname){
  const user = getUser(req);

  // 登录（无需 token）
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const u = verifyUser(body.username, body.password);
    if (!u) return send(res, 401, { error: '用户名或密码错误' });
    const token = newToken();
    u.lastLogin = new Date().toISOString();
    sessions.set(token, u.id);
    saveSessions();
    saveDB(DB);
    return send(res, 200, { token, user: publicUser(u) });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    let hit = false;
    for (const t of tokenCandidates(req)) { if (sessions.delete(t)) hit = true; }
    if (hit) saveSessions();
    return send(res, 200, { ok: true });
  }

  // 以下均需要登录
  if (!user) return send(res, 401, { error: '未登录' });

  if (pathname === '/api/me' && req.method === 'GET') {
    return send(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    return send(res, 200, {
      version: APP_VERSION,
      me: publicUser(user),
      users: DB.users.map(publicUser),
      config: DB.config,
      workOrders: DB.workOrders,
      daily: DB.daily
    });
  }

  // 导入 Excel（base64）
  if (pathname === '/api/import' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.data) return send(res, 400, { error: '缺少文件数据' });
    let buf;
    try { buf = Buffer.from(body.data, 'base64'); } catch (e) { return send(res, 400, { error: '数据解码失败' }); }
    let mapped;
    try { mapped = parseXlsxBuffer(buf, body.filename); } catch (e) { return send(res, 400, { error: '解析失败：' + e.message }); }
    if (!mapped.length) return send(res, 400, { error: '未识别到工单数据（检查表头）' });
    const st = applyMappedOrders(mapped);
    saveDBNow(DB);   // 导入是关键写操作：落盘完成后才回执，避免"提示成功但没落盘"
    audit(user, 'import', '文件=' + (body.filename || '') + ' 行数=' + mapped.length + ' 新增=' + st.added
      + ' 更新=' + st.updated + ' 保留进度=' + st.keptProgress + ' 保护状态=' + st.protectedStatus + ' 状态未识别=' + st.unknownStatus);
    return send(res, 200, st);
  }

  /* ---------- 工单系统（ECOPv）自动同步 ----------
     ⚠️ 这四个接口的响应体里**绝不包含任何凭据**：
        - status 只给 clientId 掩码（前 2 位 + 星号）
        - config 只回报 ok + status，不回显刚提交的明文
        - 凭据明文只在服务端 saveSecrets() 落盘那一刻存在 */
  if (pathname === '/api/sync/status' && req.method === 'GET') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    return send(res, 200, syncPublicStatus());
  }
  // 保存凭据配置（仅管理员）。留空字段 = 沿用原值，便于只改间隔/开关。
  if (pathname === '/api/sync/config' && req.method === 'POST') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    if (!CRMSYNC) return send(res, 500, { error: '同步模块未加载' });
    const body = JSON.parse(await readBody(req) || '{}');
    const cur = loadSecrets();
    const pick = (k) => (typeof body[k] === 'string' && body[k].trim())
      ? body[k].trim()
      : (cur ? cur.ecopv[k] : '');
    const ecopv = {
      baseUrl: pick('baseUrl'),
      clientId: pick('clientId'),
      clientKey: pick('clientKey'),
      clientSecret: pick('clientSecret'),
      pageSize: Math.max(10, Math.min(500, Number(body.pageSize) || (cur ? cur.ecopv.pageSize : 200)))
    };
    if (!ecopv.baseUrl || !ecopv.clientId || !ecopv.clientKey || !ecopv.clientSecret) {
      return send(res, 400, { error: '四项凭据都要填：接口地址 / clientId / clientKey / clientSecret' });
    }
    try { const u = new URL(ecopv.baseUrl); if (!/^https?:$/.test(u.protocol)) throw new Error('bad'); }
    catch (e) { return send(res, 400, { error: '接口地址不是合法 URL（形如 https://mp.ecopv-epr.com/api）' }); }
    const intervalMinutes = Math.max(SYNC_MIN_INTERVAL_MIN, Number(body.intervalMinutes) || SYNC_DEFAULT_INTERVAL_MIN);
    const enabled = body.enabled !== false;
    saveSecrets({ ecopv, intervalMinutes, enabled });
    startSyncTimer();
    audit(user, 'sync-config', '更新工单系统凭据（间隔=' + intervalMinutes + '分 启用=' + enabled + '）');
    return send(res, 200, { ok: true, status: syncPublicStatus() });
  }
  // 清除凭据（仅管理员）
  if (pathname === '/api/sync/clear' && req.method === 'POST') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    try { if (fs.existsSync(SECRETS_FILE)) fs.unlinkSync(SECRETS_FILE); } catch (e) { /* 忽略 */ }
    SYNC_STATE.lastResult = null; SYNC_STATE.lastError = null; SYNC_STATE.lastRunAt = null;
    SYNC_STATE.lastTrigger = null; SYNC_STATE.lastDurationMs = null; SYNC_STATE.consecutiveFailures = 0;
    startSyncTimer();
    audit(user, 'sync-config', '清除工单系统凭据');
    return send(res, 200, { ok: true, status: syncPublicStatus() });
  }
  // 立即同步（仅管理员）。全量拉取耗时较长 → 立刻回 202，进度由 status 轮询。
  if (pathname === '/api/sync/run' && req.method === 'POST') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    if (SYNC_STATE.running) return send(res, 409, { error: '同步正在进行中' });
    if (!loadSecrets()) return send(res, 400, { error: '尚未配置工单系统凭据' });
    runSync('manual').catch(() => {});
    return send(res, 202, { ok: true, started: true, status: syncPublicStatus() });
  }
  /* 🔑 查看凭据明文 —— **全站唯一的凭据出口**。
     规则（三道，缺一不可）：
       ① 角色必须是 root：admin / specialist 调 → 403（管理员看不到）；
       ② 必须二次输入自己的登录密码：错误 → 401 并记失败审计（防会话被盗后直接读走）；
       ③ 明文本响应一次性返回，不落任何静态文件、不进 data.json、不进任何其它接口。
     每次成功/失败都写 audit.log，可追溯"谁在什么时候看过凭据"。 */
  if (pathname === '/api/sync/credentials' && req.method === 'POST') {
    if (!isRoot(user)) return send(res, 403, { error: '仅最高权限账号可查看' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.password || hashPw(String(body.password), user.salt) !== user.passwordHash) {
      audit(user, 'sync-credentials', '查看凭据失败：二次密码不正确');
      /* ⚠️ 这里必须用 400 而不是 401：前端 api() 把**任何非 /api/login 的 401** 都当作
         "登录已失效" 并强制登出 —— 若用 401，Tommy 输错一次密码就会被踢出登录。 */
      return send(res, 400, { error: '登录密码不正确' });
    }
    const s = loadSecrets();
    if (!s) return send(res, 404, { error: '尚未配置工单系统凭据' });
    audit(user, 'sync-credentials', '查看工单系统凭据明文');
    return send(res, 200, { credentials: {
      baseUrl: s.ecopv.baseUrl,
      clientId: s.ecopv.clientId,
      clientKey: s.ecopv.clientKey,
      clientSecret: s.ecopv.clientSecret
    } });
  }

  /* 录入单个工单的注册步骤：核心逻辑，单条接口与批量接口共用，保证行为一致。
     dailyIndex 是「已自动记点的工单号」Set，用于 O(1) 去重，避免每次 some() 全量扫描 daily。 */
  function applyStepToOrder(o, n, note, date, user, bizSet, stat){
    const total = getSteps(o.country, o.serviceItem).length;
    o.history = o.history || [];
    const bizKey = 'reg|' + o.orderNo + '|' + n;
    /* 同一项业务只赋一次分：同一工单的同一步已经做过 → 直接跳过，
       既不重复写步骤历史，也不重复记分（甲做过了、乙再做一遍不给分）。
       bizSet 是「已有的注册业务键」集合（含历史数据），历史里已有该步也一并拦住。 */
    if (o.history.some(h => Number(h.step) === Number(n)) || (bizSet && bizSet.has(bizKey))) {
      if (stat) stat.skipped++;
      return false;
    }
    o.history.push({ date: date, step: n, operator: user.displayName, note: note || '' });
    o.progressNote = (o.progressNote ? o.progressNote + '；' : '') + date.slice(5) + ' 完成第' + n + '步' + (note ? ('：' + note) : '');
    let completedNow = false;
    if (n >= total) { o.status = '已下证'; if (!o.certNo) o.certNo = '待补充'; completedNow = true; }
    else { o.status = n <= 1 ? '待注册' : '注册中'; }

    /* 注册记点：**每完成一步就记 1 分**（固定，不再乘难度系数），归属实际操作人。
       工作类型固定走 wt_reg（页面叫「注册协助」）。 */
    DB.daily.push({
      // 批量写入时同一毫秒会产生重复 id，故加随机后缀
      id: 'd' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      date: date, type: 'wt_reg', agent: user.displayName,
      country: o.country, serviceItem: o.serviceItem, orderNo: o.orderNo,
      step: n,
      note: '完成注册第 ' + n + ' 步（每步 ' + REG_STEP_POINTS + ' 分）',
      cross: false, points: REG_STEP_POINTS, evidence: [], done: false, bizKey: bizKey
    });
    if (bizSet) bizSet.add(bizKey);
    if (stat) stat.awarded++;
    return completedNow;
  }
  /* 已有注册业务键集合：优先用记录上的 bizKey；兼容早期没有 bizKey 的记录（按 type+工单号+步骤兜底） */
  function collectRegBizKeys(){
    const s = new Set();
    for (const d of DB.daily) {
      if (d.type !== 'wt_reg') continue;
      if (d.bizKey) s.add(d.bizKey);
      else if (d.orderNo != null) s.add('reg|' + d.orderNo + '|' + (d.step == null ? '' : d.step));
    }
    return s;
  }

  // 录入注册进度（按工单号）
  let m = pathname.match(/^\/api\/order\/([^/]+)\/step$/);
  if (m && req.method === 'POST') {
    const orderNo = decodeURIComponent(m[1]);
    const body = JSON.parse(await readBody(req) || '{}');
    const o = DB.workOrders.find(x => x.orderNo === orderNo);
    if (!o) return send(res, 404, { error: '工单不存在' });
    const n = parseInt(body.step, 10);
    if (!n || n < 1) return send(res, 400, { error: '步骤无效' });
    const date = body.date || todayStr();
    const di = collectRegBizKeys();
    const stat = { awarded: 0, skipped: 0 };
    applyStepToOrder(o, n, body.note, date, user, di, stat);
    saveDBNow(DB);
    return send(res, 200, { ok: true, order: o, awarded: stat.awarded, skipped: stat.skipped });
  }

  /* 批量录入注册步骤（性能关键）
     原来前端是「逐条 await」：选 100 个工单 × 3 个步骤 = 300 次串行 HTTP，
     每次都做一次全量 find + 一次落盘，界面会长时间卡死。
     改为一次请求在服务端完成：建 Map 索引 O(1) 查找，全程只落盘一次。 */
  if (pathname === '/api/order/steps/batch' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const orderNos = Array.isArray(body.orderNos) ? body.orderNos : [];
    const steps = (Array.isArray(body.steps) ? body.steps : [])
      .map(x => parseInt(x, 10)).filter(x => x > 0).sort((a, b) => a - b);
    if (!orderNos.length) return send(res, 400, { error: '缺少工单号' });
    if (!steps.length) return send(res, 400, { error: '缺少步骤' });
    const date = body.date || todayStr();
    const note = body.note || '';
    // 工单号 → 工单对象 索引，避免每个工单都 find 全量数组
    const idx = new Map();
    for (let i = 0; i < DB.workOrders.length; i++) {
      const o = DB.workOrders[i];
      if (o && o.orderNo != null) idx.set(String(o.orderNo), o);
    }
    const di = collectRegBizKeys();
    const stat = { awarded: 0, skipped: 0 };
    let okCount = 0, failCount = 0, notFound = 0;
    for (const raw of orderNos) {
      const o = idx.get(String(raw));
      if (!o) { notFound++; failCount++; continue; }
      try { for (const n of steps) applyStepToOrder(o, n, note, date, user, di, stat); okCount++; }
      catch (e) { failCount++; }
    }
    saveDBNow(DB); // 只落盘一次
    return send(res, 200, { ok: true, okCount, failCount, notFound, awarded: stat.awarded, skipped: stat.skipped });
  }

  // 录入其他工作（含凭证 base64 上传）
  if (pathname === '/api/daily' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.type) return send(res, 400, { error: '缺少工作类型' });
    /* 申报（wt_dec）按工单去重：同一张工单只记一次申报分 ——
       甲做过了、乙再做一遍，不给重复赋分。 */
    const isDec = body.type === 'wt_dec' && !!body.orderNo;
    if (isDec) {
      const dup = DB.daily.find(d => d.type === 'wt_dec' && d.orderNo === body.orderNo);
      if (dup) return send(res, 409, { error: '该工单已完成申报记分，不能重复赋分', duplicate: true, orderNo: body.orderNo });
    }
    const evi = [];
    for (const e of (body.evidence || [])) {
      if (e.data) {
        try {
          const buf = Buffer.from(e.data, 'base64');
          const ext = (e.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
          const fn = 'evi_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex') + '.' + ext;
          fs.writeFileSync(path.join(UPLOADS, fn), buf);
          evi.push({ name: e.name, type: e.type || '', file: fn });
        } catch (err) { console.error('凭证保存失败', err); }
      } else {
        evi.push({ name: e.name, type: e.type || '', file: '' });
      }
    }
    const rec = {
      id: 'd' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      date: body.date || todayStr(), type: body.type, agent: user.displayName,
      country: body.country || '', serviceItem: body.serviceItem || '', orderNo: body.orderNo || '',
      note: body.note || '', cross: !!body.cross, points: workTypePoints(body.type), evidence: evi, done: false,
      /* 2026-10-13 需求：业务人员勾选「请求加分」提交 → 管理员在「录入明细」里看到待处理红标并酌情给分。
         requestBonus 记录"发起过请求"，bonusHandled 记录"管理员已给过分"（两者都保留，便于追溯）。 */
      requestBonus: !!body.requestBonus, bonusHandled: false,
      bizKey: isDec ? ('dec|' + body.orderNo) : ''
    };
    DB.daily.push(rec);
    saveDBNow(DB);
    return send(res, 200, { ok: true, record: rec });
  }

  /* 修改单条工作量记录的点数（「工作量点数 → 录入明细」里的改分按钮）。
     权限：管理员可改任意一条；专员只能改自己录入的那条，防止互相改分。 */
  if (pathname === '/api/daily/points' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const rec = DB.daily.find(d => d.id === body.id);
    if (!rec) return send(res, 404, { error: '记录不存在' });
    const pts = Number(body.points);
    if (!Number.isFinite(pts) || pts < 0) return send(res, 400, { error: '点数必须是不小于 0 的数字' });
    /* 权限：**只有管理员**能修正点数（业务人员在前端连「改分」列都看不到，这里再兜一层）。 */
    if (!isAdminLike(user)) {
      audit(user, 'daily-points-denied', '非管理员尝试修改点数，已拒绝（记录 ' + rec.id + '：' + rec.agent + ' ' + (rec.date || '') + '）');
      return send(res, 403, { error: '只有管理员可以修正点数' });
    }
    const old = rec.points;
    rec.points = pts;
    /* 「请求加分」的记录：管理员一经给分即视为已处理（requestBonus 保留，红色高亮消失、改显示「已处理」）。 */
    if (rec.requestBonus) rec.bonusHandled = true;
    audit(user, 'daily-points', '点数 ' + old + ' → ' + pts + '（记录 ' + rec.id + '：' + rec.agent + ' ' + (rec.date || '') + ' ' + rec.type + ' ' + (rec.orderNo || '') + '）');
    saveDBNow(DB);
    return send(res, 200, { ok: true, record: rec });
  }

  // 更新基础配置
  if (pathname === '/api/config' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.config) {
      /* 权限：业务人员（非管理员）在配置里**只能改「各国注册步骤」**（config.steps），
         与前端「只显示各国注册步骤页签」对齐。其余字段（国家-负责人 / 工作类型及点数）
         若被改动则一律忽略，并留一条审计，避免绕过界面改配置。管理员不受限。 */
      if (!isAdminLike(user)) {
        const blocked = Object.keys(body.config).filter(k => k !== 'steps'
          && JSON.stringify(body.config[k]) !== JSON.stringify(DB.config[k]));
        if (blocked.length) audit(user, 'config-blocked', '非管理员尝试修改受限配置项，已忽略：' + blocked.join(','));
        if (body.config.steps !== undefined && body.config.steps && typeof body.config.steps === 'object') {
          /* 再收一层：非管理员**只能改自己管辖国家**的注册步骤。
             前端虽然只列出自己的国家，但接口层也要挡住"绕过界面改别国步骤"。
             注：读取不受限（录入页需要所有国家的步骤才能给跨国家工单算步骤数），
             这里只限制"写"。未被授权的 key 一律保留服务端原值（也顺带避免了
             专员用本地旧副本把别国步骤覆盖掉的老问题）。 */
          const mine = new Set();
          for (const [c, arr] of Object.entries(DB.config.managers || {})) {
            if (Array.isArray(arr) && arr.includes(user.displayName)) mine.add(c);
          }
          /* 用 Object.create(null) 承载 next，并显式跳过原型相关键：
             请求体一旦出现 "__proto__"，`next[k] = v` 会命中 Object.prototype 上的
             setter 造成原型污染（CodeQL: js/remote-property-injection）。
             null-prototype 对象没有该 setter，属于根治；下面的显式跳过是第二道防线。 */
          const next = Object.assign(Object.create(null), DB.config.steps || {});
          const denied = [];
          for (const [k, v] of Object.entries(body.config.steps)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') { denied.push(k); continue; }
            const c = String(k).split('|')[0];
            if (mine.has(c)) next[k] = v;
            else if (JSON.stringify(v) !== JSON.stringify((DB.config.steps || {})[k])) denied.push(k);
          }
          if (denied.length) audit(user, 'steps-blocked', '非管理员尝试修改非管辖国家的注册步骤，已忽略：' + denied.slice(0, 20).join(', ') + (denied.length > 20 ? (' 等 ' + denied.length + ' 项') : ''));
          DB.config.steps = next;
        }
      } else {
        audit(user, 'config', '覆盖全局配置字段: ' + Object.keys(body.config).join(','));
        DB.config = Object.assign(DB.config, body.config);
      }
      saveDBNow(DB);   // 配置是用户手动保存的设置，必须落盘完成再回执
    }
    return send(res, 200, { ok: true, config: DB.config });
  }

  // 用户管理（仅管理员）
  if (pathname === '/api/users' && req.method === 'GET') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    return send(res, 200, { users: DB.users.map(publicUser) });
  }
  if (pathname === '/api/users' && req.method === 'POST') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.username || !body.password || !body.displayName) return send(res, 400, { error: '缺少账号/姓名/密码' });
    if (DB.users.find(x => x.username === body.username)) return send(res, 400, { error: '账号已存在' });
    const wantedRole = normRole(body.role);
    /* 防提权：普通管理员不能造 root，否则「admin 看不到凭据」的隔离会被自己绕过 */
    if (wantedRole === 'root' && !isRoot(user)) return send(res, 403, { error: '只有最高权限账号能创建最高权限账号' });
    const u = makeUser(body.username, body.displayName, wantedRole, body.password);
    DB.users.push(u);
    saveDBNow(DB);
    return send(res, 200, { user: publicUser(u) });
  }
  let um = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (um && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    const uid = decodeURIComponent(um[1]);
    const idx = DB.users.findIndex(x => x.id === uid || x.username === uid);
    const target = DB.users[idx];
    if (!target) return send(res, 404, { error: '用户不存在' });
    /* 只有 root 能操作 root 账号：普通管理员既不能改它、也不能删它 */
    if (target.role === 'root' && !isRoot(user)) return send(res, 403, { error: '只有最高权限账号能操作最高权限账号' });
    if (req.method === 'DELETE') {
      if (target.id === user.id) return send(res, 400, { error: '不能删除当前登录账号' });
      const bossCnt = DB.users.filter(x => x.role === 'admin' || x.role === 'root').length;
      if ((target.role === 'admin' || target.role === 'root') && bossCnt <= 1) return send(res, 400, { error: '至少保留一个管理员' });
      DB.users.splice(idx, 1);
      // 清理该用户会话
      for (const [tok, id] of sessions.entries()) { if (id === target.id) sessions.delete(tok); }
      saveSessions();
      saveDBNow(DB);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.displayName) target.displayName = body.displayName;
      if (body.username) {
        if (DB.users.find(x => x.username === body.username && x.id !== target.id)) return send(res, 400, { error: '账号已存在' });
        target.username = body.username;
      }
      if (body.role) {
        const nr = normRole(body.role);
        if (nr === 'root' && !isRoot(user)) return send(res, 403, { error: '只有最高权限账号能授予最高权限' });
        const bossCnt = DB.users.filter(x => x.role === 'admin' || x.role === 'root').length;
        const wasBoss = (target.role === 'admin' || target.role === 'root');
        const willBoss = (nr === 'admin' || nr === 'root');
        if (wasBoss && !willBoss && bossCnt <= 1 && target.id !== user.id) return send(res, 400, { error: '至少保留一个管理员' });
        if (target.id === user.id && !willBoss) return send(res, 400, { error: '不能降级当前登录管理员' });
        target.role = nr;
      }
      if (body.password && body.password.trim()) {
        target.passwordHash = hashPw(body.password, target.salt);
      }
      saveDBNow(DB);
      return send(res, 200, { user: publicUser(target) });
    }
  }

  // 载入示例（仅管理员：会整体覆盖工单，普通人不可碰）
  if (pathname === '/api/seed' && req.method === 'POST') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    const snap = writeSnapshot('before-seed');   // 覆盖前留底，可回滚
    audit(user, 'seed', '载入示例数据，整体覆盖全部工单与录入记录' + (snap ? '（已存底档 ' + snap + '）' : ''));
    seedDemo();
    return send(res, 200, { ok: true, total: DB.workOrders.length });
  }

  // 清空数据（仅管理员）
  //   { full: false }（默认）：仅清空工单，保留负责人 / 注册步骤 / 工作点数等配置
  //   { full: true }：全部清空（含国家负责人、注册步骤、工作点配置与录入记录），回到初始态
  if (pathname === '/api/reset' && req.method === 'POST') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
    const snap = writeSnapshot('before-reset');  // 清空前留底：清完也能一键回滚
    try { fs.writeFileSync(RESET_MARKER, new Date().toISOString()); } catch (e) {}  // 标记为"显式清空"，启动时不自动复活
    audit(user, 'reset', (body.full ? 'full=true 清空全部（含配置与录入记录）' : 'full=false 仅清空全部工单')
                        + '（已存底档 ' + (snap || '失败') + '）');
    if (body.full) {
      DB.workOrders = []; DB.daily = [];
      DB.config = { managers: {}, workTypes: DEFAULT_WORKTYPES.map(w => ({ ...w })), steps: {}, weights: {} };
    } else {
      DB.workOrders = [];
    }
    saveDBNow(DB);
    return send(res, 200, { ok: true, full: !!body.full });
  }

  /* 按国家清空工单（国家负责人只能清自己负责的国家；管理员可清任意国家或全部）
     - body: { countries: ['希腊','意大利'] }  或  { all: true }
     - 同步清理这些工单对应的工作量记录（daily），避免出现"有工作量、无工单"的脏数据
     - 清空前自动留快照，可一键回滚 */
  if (pathname === '/api/reset-orders' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
    const all = !!body.all;
    const countries = Array.isArray(body.countries) ? body.countries.map(x => String(x)).filter(Boolean) : [];
    const isAdmin = isAdminLike(user);
    // 我负责的国家 = config.managers 里负责人包含我姓名的国家
    const mine = Object.keys(DB.config.managers || {})
      .filter(c => (DB.config.managers[c] || []).indexOf(user.displayName) >= 0);
    if (all) {
      if (!isAdmin) return send(res, 403, { error: '仅管理员可清空全部工单' });
    } else {
      if (!countries.length) return send(res, 400, { error: '请选择要清空的国家' });
      const notMine = countries.filter(c => !isAdmin && mine.indexOf(c) < 0);
      if (notMine.length) return send(res, 403, { error: '你只能清空自己负责的国家：' + notMine.join('、') });
    }
    const scope = all ? null : new Set(countries);
    // 先算出要删哪些（不直接改动），确认有东西可删再留底档
    const hitList = DB.workOrders.filter(o => all || scope.has(o.country));
    const removed = hitList.length;
    const dailyHit = DB.daily.filter(d => d.orderNo && hitList.some(o => o.orderNo === d.orderNo));
    const scopeText = all ? '全部国家' : countries.join('、');
    if (!removed) {
      return send(res, 200, { ok: true, removed: 0, dailyRemoved: 0, remaining: DB.workOrders.length, scope: scopeText });
    }
    // ⚠️ 必须在改动 DB 之前留底档，否则快照存的是"清空后"的状态，回滚就回不去了
    const snap = writeSnapshot('before-reset-orders');
    const removedNos = new Set(hitList.map(o => o.orderNo));
    DB.workOrders = DB.workOrders.filter(o => !(all || scope.has(o.country)));
    DB.daily = DB.daily.filter(d => !(d.orderNo && removedNos.has(d.orderNo)));
    const dailyRemoved = dailyHit.length;
    // 若清完整个库都空了，标记为"显式清空"，启动时不被自动自愈复活
    if (!DB.workOrders.length) { try { fs.writeFileSync(RESET_MARKER, new Date().toISOString()); } catch (e) {} }
    saveDBNow(DB);
    audit(user, 'reset-orders', scopeText + ' 删除工单 ' + removed + ' 条 / 工作量 ' + dailyRemoved + ' 条（已存底档 ' + (snap || '失败') + '）');
    return send(res, 200, { ok: true, removed, dailyRemoved, remaining: DB.workOrders.length, scope: scopeText, snapshot: snap });
  }

  /* ---------- 数据备份与恢复（仅管理员） ---------- */
  // 下载当前完整数据（data.json），用于本地留底 / 迁移
  if (pathname === '/api/backup' && req.method === 'GET') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    try {
      const raw = fs.readFileSync(DATA);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="epr-data-' + stamp + '.json"',
        'Content-Length': raw.length,
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(raw);
    } catch (e) { return send(res, 500, { error: '导出失败：' + e.message }); }
  }
  // 列出可回滚的快照
  if (pathname === '/api/backups' && req.method === 'GET') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    const backups = listBackups().sort((a, b) => String(b.time).localeCompare(String(a.time)));
    return send(res, 200, { current: { orders: (DB.workOrders || []).length, daily: (DB.daily || []).length },
                            keep: BACKUP_KEEP, gapMin: Math.round(BACKUP_MIN_GAP_MS / 60000), backups });
  }
  // 从某个快照回滚
  if (pathname === '/api/restore' && req.method === 'POST') {
    if (!isAdminLike(user)) return send(res, 403, { error: '仅管理员可操作' });
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
    const name = String(body.name || '');
    if (!/^data-\d{8}-\d{6}(-\d{1,3})?\.json\.gz$/.test(name)) return send(res, 400, { error: '快照名不合法' });
    const p = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(p)) return send(res, 404, { error: '快照不存在' });
    let snap = null;
    try { snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')); }
    catch (e) { return send(res, 400, { error: '快照损坏，无法解析' }); }
    if (!snap || !Array.isArray(snap.workOrders)) return send(res, 400, { error: '快照内容不可用' });
    writeSnapshot('before-restore');       // 先把"当前状态"也留一份，回滚可逆
    audit(user, 'restore', '从快照 ' + name + ' 恢复：工单 ' + snap.workOrders.length + ' 条');
    snap.users = DB.users;                 // 账号始终沿用当前库，避免把历史密码回滚回来
    DB = snap;
    saveDBNow(DB);                         // 回滚是恢复操作，必须落盘完成再回执
    return send(res, 200, { ok: true, workOrders: (DB.workOrders || []).length, daily: (DB.daily || []).length });
  }

  // 凭证文件访问
  if (pathname.startsWith('/uploads/')) {
    return serveStatic(req, res, pathname);
  }

  return send(res, 404, { error: '未知接口' });
}
function publicUser(u){ return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, lastLogin: u.lastLogin || null }; }
function todayStr(){ return new Date().toISOString().slice(0, 10); }

function seedDemo(){
  const mk = (country, svc, status, company, agent) => ({
    orderNo: 'WR' + Math.floor(Math.random() * 1e9), status, orderDate: '2026-08-1' + Math.floor(Math.random() * 9),
    regType: '首次注册', certNo: '', customerNo: 'XM' + Math.floor(Math.random() * 9999),
    companyCn: company, companyEn: company, agent, country, serviceItem: svc, firstYear: '2026',
    serviceStart: '2026-01-01', serviceEnd: '2026-12-31', provider: '奥地利ERP', recycling: '含回收',
    progressNote: '', history: []
  });
  DB.workOrders = [
    mk('奥地利','奥地利包装法','注册中','江苏奥功电能科技有限公司','西美'),
    mk('奥地利','奥地利包装法','待注册','香港碧知雅有限公司','星商'),
    mk('奥地利','奥地利WEEE','注册中','Coros Wearables Inc','华之星'),
    mk('奥地利','奥地利电池法','待下证','菏泽鹏阳电子商务','星商'),
    mk('奥地利','奥地利包装法','已下证','烟台冷冬电子商务','星商'),
    mk('奥地利','奥地利WEEE','待提交','宁波跨境贸易','欧-散客')
  ];
  DB.daily = [
    { id:'d1', date:'2026-08-20', type:'wt_reg', agent:'张明', country:'奥地利', serviceItem:'奥地利包装法', orderNo:'WR1', note:'注册第2步', cross:false, points:10, evidence:[], done:false },
    { id:'d2', date:'2026-08-20', type:'wt_pro', agent:'张明', country:'奥地利', serviceItem:'奥地利WEEE', note:'PRO邮件确认申报', cross:false, points:4, evidence:[], done:false },
    { id:'d3', date:'2026-08-21', type:'wt_reg', agent:'李婷', country:'奥地利', serviceItem:'奥地利电池法', orderNo:'WR2', note:'注册第3步', cross:false, points:10, evidence:[], done:false },
    { id:'d4', date:'2026-08-21', type:'wt_cross', agent:'王浩', country:'奥地利', serviceItem:'奥地利包装法', note:'协助李婷处理包装法', cross:true, points:7, evidence:[], done:false },
    { id:'d5', date:'2026-08-22', type:'wt_dec', agent:'李婷', country:'奥地利', serviceItem:'奥地利WEEE', note:'月度申报', cross:false, points:8, evidence:[], done:false }
  ];
  [...new Set(DB.workOrders.map(o => stepKey(o.country, o.serviceItem)))].forEach(k => { if (!DB.config.steps[k]) DB.config.steps[k] = GENERIC_STEPS.slice(); });
  saveDBNow(DB);
}

/* ---------- 主服务 ---------- */
const server = http.createServer(async (req, res) => {
  _currentReq = req; // 供 send() 判断 gzip 用
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/') || p.startsWith('/uploads/')) {
      await handleApi(req, res, p);
    } else {
      serveStatic(req, res, p);
    }
  } catch (e) {
    console.error('请求处理异常', e);
    if (!res.headersSent) send(res, 500, { error: '服务器错误：' + e.message });
  }
});
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('✗ 端口 ' + PORT + ' 已被占用！很可能已有另一个 EPR 服务实例在运行。本进程已退出，避免双实例写坏数据。');
  } else {
    console.error('✗ 服务启动失败：', e);
  }
  process.exit(1);
});
server.listen(PORT, () => {
  console.log('欧洲EPR控制台已启动 → http://localhost:' + PORT);
  console.log('默认账号：admin / admin123（管理员）。其他账号请用管理员在「基础配置 → 员工账号」中创建。');
  /* 工单系统自动同步：按 secrets.json 的配置起定时器。
     未配置凭据 / 未开启自动同步 → 一律静默跳过，主功能完全不受影响。
     ⚠️ 启动补跑也只在"开启了自动同步"时才做 —— 否则用户只是填了凭据、
     重启一次服务就会被动触发一次全量拉取，属于意料之外的行为。 */
  try {
    startSyncTimer();
    const s = loadSecrets();
    if (s && s.enabled) setTimeout(() => { runSync('startup').catch(() => {}); }, 90 * 1000);
  } catch (e) { console.error('[sync] 初始化失败：', e && e.message); }
});
