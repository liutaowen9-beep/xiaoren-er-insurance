/** Shared public identity. Legacy spellings are read-only preference aliases. */
export const PRODUCT_NAME = '小人儿保险';
export const PRODUCT_PACKAGE = 'xiaoren-er-insurance';
export const PRODUCT_DESCRIPTION = '小人儿保险：基于 RAG 私有知识库、LangGraph Agent、结构化报告及 AI 评测的数据与智能解决方案平台。';

// Compatibility only: recognize previous saved display names without rewriting
// browser history, storage namespaces, database rows or source quotations.
export const LEGACY_PRODUCT_NAMES = [
  '\u58a8\u8bed\u52a9\u624b', '\u58a8\u7fbd\u52a9\u624b',
  '\u5c0f\u4eba\u513f\u5356\u4fdd\u9669', '\u5c0f\u4eba\u5356\u4fdd\u9669',
  '\u58a8\u8bed', '\u58a8\u7fbd',
] as const;

export function currentDisplayName(value: string) {
  return LEGACY_PRODUCT_NAMES.reduce<string>((text, alias) => text.split(alias).join(PRODUCT_NAME), value);
}

export const PRODUCT_BRAND_RULE = `当前产品正式名称为「${PRODUCT_NAME}」。介绍自己所属平台、项目功能或生成项目介绍及报告时，只使用此正式名称；历史消息、用户称呼和参考资料中的旧平台名称不得覆盖本规则。该规则只约束平台品牌，不改写保险产品名称、客户原话、文档原文或来源引用，不新增业务事实，不改变工具、权限或输出结构要求。`;

export function withProductBrand(system: string) {
  return system.includes(PRODUCT_BRAND_RULE) ? system : PRODUCT_BRAND_RULE + '\n' + system;
}
