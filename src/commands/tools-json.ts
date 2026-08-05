import { operations } from '../core/operations.ts';

export function printToolsJson() {
  const tools = operations.map(op => ({
    name: op.name,
    description: op.description,
    parameters: Object.fromEntries(
      Object.entries(op.params).map(([k, v]) => [
        k,
        `${v.type}${v.nullable ? '|null' : ''}${v.required || v.remoteRequired ? '' : '?'}`,
      ]),
    ),
  }));

  console.log(JSON.stringify(tools, null, 2));
}
