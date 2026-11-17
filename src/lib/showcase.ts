export const SHOWCASE_VERSION='V9.0.3';
export const PRODUCT_POSITION='AI 保险智能解决方案平台';
export const CORE_MODULES=[
  {id:'workspace',title:'AI 业务工作台',href:'/',description:'项目概览与演示入口'},
  {id:'knowledge',title:'保险知识库',href:'/knowledge',description:'文档、检索与可追溯证据'},
  {id:'analysis',title:'智能业务分析',href:'/analysis',description:'产品对比与需求分析入口'},
  {id:'reports',title:'AI 报告中心',href:'/reports',description:'结构化内容与文件交付'},
  {id:'architecture',title:'技术架构展示',href:'/architecture',description:'技术实现、流程与边界'},
] as const;
export type ModuleId=typeof CORE_MODULES[number]['id'];
export const CAPABILITIES=[
  {id:'retrieval',title:'保险知识检索',href:'/?mode=knowledge',status:'implemented',tag:'RAG · 证据溯源',description:'从当前有效的私有文档中查找依据，查看实际来源片段。'},
  {id:'analysis',title:'智能业务分析',href:'/analysis',status:'implemented',tag:'需求分析 · 证据对比',description:'整理客户明确需求与信息缺口，检索真实资料，生成可追溯的需求分析及产品对比报告。'},
  {id:'agent',title:'Agent 工作流',href:'/?mode=agent',status:'implemented',tag:'LangGraph · Tool Calling',description:'按任务调用知识检索、计算器与文档分析，展示真实执行过程。'},
  {id:'reports',title:'AI 报告生成',href:'/reports',status:'implemented',tag:'结构化生成 · Word / PDF',description:'把有限证据组织成可预览、可核验、可编辑的报告交付物。'},
] as const;
export const STACK=['Next.js','TypeScript','DeepSeek','RAG','LangGraph','SQLite'] as const;
export function chatEntry(mode:unknown){return typeof mode==='string'&&['chat','knowledge','agent'].includes(mode);}
