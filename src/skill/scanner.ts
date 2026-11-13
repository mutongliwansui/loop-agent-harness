import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillMetadata, SkillScope, ParsedSkillMd } from './types.js';

/** 解析 SKILL.md 的 YAML frontmatter */
export function parseSkillMd(filePath: string): ParsedSkillMd | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // 去 UTF-8 BOM（Windows 编辑器常见，避免 ^--- 匹配失败）
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  // 匹配 --- ... --- 之间的 YAML（兼容 CRLF / LF 换行）
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;

  const yaml = match[1];
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  if (!nameMatch || !descMatch) return null;

  const name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
  const description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
  if (!name || !description) return null;

  return {
    name,
    description,
    body: content.slice(match[0].length),
  };
}

/** 扫描指定目录下的所有 Skill */
export function scanSkillsDir(dir: string, scope: SkillScope): SkillMetadata[] {
  if (!existsSync(dir)) return [];
  const skills: SkillMetadata[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }

  for (const entry of entries) {
    const skillDir = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(skillDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const skillMdPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    const parsed = parseSkillMd(skillMdPath);
    if (!parsed) continue;

    skills.push({
      name: parsed.name,
      description: parsed.description,
      path: skillMdPath,
      dir: skillDir,
      scope,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** 格式化 Skill 列表用于调试 */
export function formatSkillList(skills: SkillMetadata[]): string {
  if (skills.length === 0) return '  (无可用 Skill)';
  return skills
    .map((s) => `  [G] ${s.name}: ${s.description}`)
    .join('\n');
}
