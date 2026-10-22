/**
 * WebUI MD 图表增强纯逻辑测试（Task-20261023-001 D8）
 *
 * 覆盖 extractEChartsOption（webui/src/echarts.ts）：
 * - 合法 JSON 对象 → 原样返回
 * - 空串 / 空白 → null
 * - 非法 JSON → null
 * - 数组 / null / 标量 → null（必须是对象）
 * DOM 渲染（KaTeX 排版、echarts/mermaid 容器交互）列入任务文档 6.4 人工验证清单。
 */
import { describe, it, expect } from 'vitest';
import { extractEChartsOption } from '../webui/src/echarts.js';

describe('extractEChartsOption', () => {
  it('合法 JSON 对象原样返回', () => {
    const src = '{"xAxis":{"type":"category","data":["Mon","Tue"]},"series":[{"type":"line"}]}';
    expect(extractEChartsOption(src)).toEqual({
      xAxis: { type: 'category', data: ['Mon', 'Tue'] },
      series: [{ type: 'line' }],
    });
  });

  it('容忍首尾空白与换行', () => {
    expect(extractEChartsOption('  \n{"title":{"text":"t"}}\n  ')).toEqual({ title: { text: 't' } });
  });

  it('空串与纯空白返回 null', () => {
    expect(extractEChartsOption('')).toBeNull();
    expect(extractEChartsOption('   \n\t')).toBeNull();
  });

  it('非法 JSON 返回 null（含 JS 表达式与尾逗号）', () => {
    expect(extractEChartsOption('const option = {x: 1}')).toBeNull(); // D4：拒绝脚本
    expect(extractEChartsOption('{"x": 1,}')).toBeNull();
    expect(extractEChartsOption('{x: 1}')).toBeNull(); // 键必须带引号
    expect(extractEChartsOption('not json')).toBeNull();
  });

  it('数组、null、标量返回 null（必须是对象）', () => {
    expect(extractEChartsOption('[1,2,3]')).toBeNull();
    expect(extractEChartsOption('null')).toBeNull();
    expect(extractEChartsOption('42')).toBeNull();
    expect(extractEChartsOption('"str"')).toBeNull();
    expect(extractEChartsOption('true')).toBeNull();
  });
});
