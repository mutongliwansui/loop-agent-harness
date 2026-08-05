// 深合并工具：后者覆盖前者
// - 数组：后者直接替换（不做 concat）
// - 对象：递归合并
// - 基本类型：后者覆盖
// - undefined：跳过，保留前值

type PlainObj = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObj {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v)
  );
}

/**
 * 深合并多个对象，返回合并后的新对象
 * 参数越靠后的优先级越高
 */
export function deepMerge<T>(...objs: Array<Partial<T> | undefined | null>): T {
  const result: PlainObj = {};

  for (const obj of objs) {
    if (!obj) continue;
    mergeInto(result, obj as PlainObj);
  }

  return result as T;
}

function mergeInto(target: PlainObj, source: PlainObj): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;

    const tgtVal = target[key];

    if (Array.isArray(srcVal)) {
      // 数组直接替换
      target[key] = srcVal.slice();
    } else if (isPlainObject(srcVal)) {
      if (isPlainObject(tgtVal)) {
        // 两者都是对象，递归合并
        mergeInto(tgtVal, srcVal);
      } else {
        // 目标不是对象，直接替换（深拷贝 source）
        target[key] = deepCopyPlain(srcVal);
      }
    } else {
      // 基本类型：直接替换
      target[key] = srcVal;
    }
  }
}

function deepCopyPlain(obj: PlainObj): PlainObj {
  const result: PlainObj = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (Array.isArray(v)) {
      result[key] = v.slice();
    } else if (isPlainObject(v)) {
      result[key] = deepCopyPlain(v);
    } else {
      result[key] = v;
    }
  }
  return result;
}
