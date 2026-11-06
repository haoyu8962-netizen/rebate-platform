// B2-04zz（FU-AUDIT-ACTOR-SETTLEMENT 实现半，编排 D10-717 ②、D10-769；契约 CT-26z）：settlement 维权命令
// rights-command.ts 的审计系统身份由暂记的 system:risk 改为 system:settlement，并删掉「契约枚举还没有
// 对应值」的 TODO。源码文本检查（不运行代码、不连库）：
//   - 文件全文（含注释）不出现 system:risk——暂记值与解释它的注释都要去掉；
//   - 去掉注释后出现字面值 system:settlement（引号不限）；
//   - 不再留有「系统身份等契约枚举」的 TODO（TODO 同一行提到 system actor 或 contract enum）；
//   - system:settlement 已在契约枚举 audit_system_actor 里（CT-26z，中文名「系统（结算）」），这里不再造值。
// 去注释的做法同 test/spec/settlement/rights-audit-port/source.test.ts：`//` 到行尾、`/* … */`。
// 只查 rights-command.ts：settlement 其余处（rebate 的 order_auto_hold）按 BR-FUND-06 仍以 system:risk 记。
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const COMMAND = new URL('apps/api/src/modules/settlement/rights/rights-command.ts', ROOT);
const ENUMS = new URL('contracts/enums/admin.yaml', ROOT);

/** The source without its comments. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

it('[AC-B2-04zz#4] rights-command.ts 全文（含注释）不出现 system:risk、不留等契约枚举的 TODO；去掉注释后出现字面值 system:settlement（契约 audit_system_actor 已有此值，中文名「系统（结算）」）', () => {
  const source = readFileSync(COMMAND, 'utf8');
  const code = withoutComments(source);
  const enums = readFileSync(ENUMS, 'utf8');

  expect(enums).toMatch(/^\s*system:settlement:\s*系统（结算）\s*$/m);
  expect(source).not.toContain('system:risk');
  expect(source).not.toMatch(/TODO[^\n]*(system actor|contract enum)/i);
  expect(code).toMatch(/['"`]system:settlement['"`]/);
});
