import 'server-only';
import Decimal from 'decimal.js';
import { AgentError } from './limits';

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });
const MAX = new D('1000000000000000');
export function calculate(expression: string) {
  if (!expression.trim() || expression.length > 240 || !/^[\d.\s+\-*/()%]+$/.test(expression)) throw new AgentError('计算式仅支持数字、小数、加减乘除、括号和百分比，长度最多 240 字符。');
  const tokens = expression.match(/\d+(?:\.\d+)?|\.\d+|[+\-*/()%]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s/g, '') || tokens.length > 128) throw new AgentError('计算式格式不正确或过于复杂。');
  let position = 0, operations = 0, depth = 0;
  function checked(value: Decimal) {
    if (!value.isFinite() || value.abs().gt(MAX) || (!value.isZero() && value.abs().lt('1e-24'))) throw new AgentError('计算数值超出允许范围（绝对值不超过 10¹⁵，非零值不小于 10⁻²⁴）。');
    return value;
  }
  function operation() { if (++operations > 64) throw new AgentError('计算操作过多，请拆分表达式。'); }
  function primary(): Decimal {
    if (++depth > 20) throw new AgentError('括号或一元运算嵌套过深。');
    let value: Decimal;
    const token = tokens[position++];
    if (token === '+' || token === '-') { operation(); value = primary(); if (token === '-') value = value.negated(); }
    else if (token === '(') { value = sum(); if (tokens[position++] !== ')') throw new AgentError('括号不匹配。'); }
    else if (token && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token) && token.replace('.', '').length <= 24) value = checked(new D(token));
    else throw new AgentError('计算式缺少数字，或数字位数超过限制。');
    while (tokens[position] === '%') { position++; operation(); value = checked(value.div(100)); }
    depth--; return checked(value);
  }
  function product(): Decimal {
    let value = primary();
    while (tokens[position] === '*' || tokens[position] === '/') {
      const operator = tokens[position++]; operation(); const right = primary();
      if (operator === '/' && right.isZero()) throw new AgentError('除数不能为零。');
      value = checked(operator === '*' ? value.mul(right) : value.div(right));
    }
    return value;
  }
  function sum(): Decimal {
    let value = product();
    while (tokens[position] === '+' || tokens[position] === '-') {
      const operator = tokens[position++]; operation(); const right = product();
      value = checked(operator === '+' ? value.plus(right) : value.minus(right));
    }
    return value;
  }
  const value = sum();
  if (position !== tokens.length) throw new AgentError('计算式含多余符号或缺少运算符。');
  return { expression, result: value.toString(), roundedAmount: value.toFixed(2), precision: 40, rounding: 'ROUND_HALF_UP', note: '采用 40 位十进制有效数字；非终止小数会舍入。金额展示单独四舍五入到两位；百分比表示该数除以 100。' };
}
