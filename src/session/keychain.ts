import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { generateSalt, createVerifyToken, verifyKey } from './crypto.js';

const KEYFILE_PATH = join(homedir(), '.loop-agent', '.keyfile');
const KEY_LEN = 32;

interface KeyFileData {
  key: string;
  salt: string;
  verifyToken: string;
  createdAt: string;
}

/** 密钥管理器：自动生成随机主密钥，无需用户输入 */
export class Keychain {
  private key: Buffer | null = null;

  /** 获取 keyfile 路径 */
  get keyfilePath(): string {
    return KEYFILE_PATH;
  }

  /** 检查密钥文件是否存在 */
  exists(): boolean {
    return existsSync(KEYFILE_PATH);
  }

  /**
   * 确保密钥已解锁（自动加载或首次生成）
   * 如果密钥文件不存在，自动生成 256-bit 随机密钥
   */
  ensureUnlocked(): void {
    if (this.key !== null) return;

    if (this.exists()) {
      this.key = this.loadKey();
    } else {
      this.key = this.generateAndSaveKey();
    }
  }

  /** 获取主密钥（已解锁） */
  getKey(): Buffer | null {
    return this.key;
  }

  /** 是否已解锁 */
  isUnlocked(): boolean {
    return this.key !== null;
  }

  /** 锁定（清除内存中的密钥） */
  lock(): void {
    this.key = null;
  }

  /** 删除密钥文件（慎用，会导致所有加密数据无法解密） */
  reset(): void {
    if (existsSync(KEYFILE_PATH)) {
      unlinkSync(KEYFILE_PATH);
    }
    this.key = null;
  }

  /** 导出主密钥为 base64 字符串（用于备份） */
  exportKey(): string | null {
    return this.key ? this.key.toString('base64') : null;
  }

  /** 从 base64 字符串导入主密钥（用于恢复） */
  importKey(keyBase64: string): boolean {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== KEY_LEN) return false;

    const dir = join(homedir(), '.loop-agent');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const salt = generateSalt();
    const verifyToken = createVerifyToken(key, salt);

    const data: KeyFileData = {
      key: key.toString('base64'),
      salt,
      verifyToken,
      createdAt: new Date().toISOString(),
    };

    writeFileSync(KEYFILE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(KEYFILE_PATH, 0o600);
    this.key = key;
    return true;
  }

  private loadKey(): Buffer {
    const data = this.readKeyFile();
    const key = Buffer.from(data.key, 'base64');

    // 验证密钥完整性
    if (!verifyKey(key, data.salt, data.verifyToken)) {
      throw new Error('密钥文件损坏，验证失败');
    }

    return key;
  }

  private generateAndSaveKey(): Buffer {
    const key = randomBytes(KEY_LEN);

    const dir = join(homedir(), '.loop-agent');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const salt = generateSalt();
    const verifyToken = createVerifyToken(key, salt);

    const data: KeyFileData = {
      key: key.toString('base64'),
      salt,
      verifyToken,
      createdAt: new Date().toISOString(),
    };

    writeFileSync(KEYFILE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(KEYFILE_PATH, 0o600);

    return key;
  }

  private readKeyFile(): KeyFileData {
    const content = readFileSync(KEYFILE_PATH, 'utf-8');
    return JSON.parse(content) as KeyFileData;
  }
}

/** 全局单例 */
export const keychain = new Keychain();
