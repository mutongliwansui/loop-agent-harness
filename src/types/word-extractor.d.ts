// word-extractor（CJS 纯 JS 包）无类型定义，按后端 /fs/doc2md 实际用到的 API 做最小环境声明
declare module 'word-extractor' {
  /** 已提取的 doc 文档 */
  interface WordDocument {
    getBody(): string;
  }
  export default class WordExtractor {
    extract(filename: string): Promise<WordDocument>;
  }
}
