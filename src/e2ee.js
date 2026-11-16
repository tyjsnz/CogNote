/**
 * Cognote 端到端加密原语（云端同步内容加密 / 加密分享）
 *
 * - AES-256-GCM，密钥由口令经 scrypt 派生（scrypt 参数两边必须一致）
 * - 确定性 nonce = HMAC-SHA256(key, aad || 0x00 || plain) 前 12 字节：
 *   同密钥同路径同内容 → 同密文（同步的 hash 比对口径稳定，不会每轮重复上传）；
 *   不同内容 nonce 必不同，杜绝 GCM nonce 重用
 * - AAD 绑定路径（share 用固定标记）：密文被搬到其它路径无法解密
 * - 密文带 7 字节魔数 CNTE2E1；无魔数视为明文（未加密模式 / 明文→加密迁移期兼容）
 * - sync-server 为独立部署的零依赖服务，其内部内联了同一套逻辑（改动需同步）
 */
const crypto = require('node:crypto');

const MAGIC = Buffer.from('CNTE2E1', 'ascii');
const SALT_DEFAULT = 'cognote-e2ee-v1';
// 低内存参数（单文件 20MB 内、笔记场景高频调用，N=16384 足够抵御口令爆破）
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + NONCE_LEN + TAG_LEN; // 35

/** 口令 → 32 字节密钥；salt 为空用应用级固定 salt（跨设备派生一致） */
function deriveKey(passphrase, salt) {
  if (!passphrase) throw new Error('缺少加密口令');
  return crypto.scryptSync(String(passphrase), salt || SALT_DEFAULT, 32, SCRYPT_OPTS);
}

function isEncrypted(buf) {
  return Buffer.isBuffer(buf) && buf.length >= HEADER_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** 明文 → 密文（确定性：同 key/aad/plain 结果恒定） */
function encrypt(key, plain, aad) {
  const aadBuf = aad == null ? null : Buffer.from(String(aad), 'utf8');
  const nonce = crypto.createHmac('sha256', key)
    .update(Buffer.concat([aadBuf || Buffer.alloc(0), Buffer.from([0]), plain]))
    .digest()
    .subarray(0, NONCE_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aadBuf) c.setAAD(aadBuf);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, nonce, c.getAuthTag(), ct]);
}

/**
 * 密文 → 明文。
 * 无魔数返回 null（调用方按明文处理，兼容迁移期）；
 * 有魔数但口令错/被篡改 → throw。
 */
function decrypt(key, buf, aad) {
  if (!isEncrypted(buf)) return null;
  const aadBuf = aad == null ? null : Buffer.from(String(aad), 'utf8');
  const nonce = buf.subarray(MAGIC.length, MAGIC.length + NONCE_LEN);
  const tag = buf.subarray(MAGIC.length + NONCE_LEN, HEADER_LEN);
  const ct = buf.subarray(HEADER_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  if (aadBuf) d.setAAD(aadBuf);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new Error('解密失败：加密口令不正确或数据已损坏');
  }
}

module.exports = { deriveKey, encrypt, decrypt, isEncrypted, MAGIC, SCRYPT_OPTS, SALT_DEFAULT };
