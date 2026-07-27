import { describe, expect, test } from 'bun:test';
import { operationIdentityForContext } from '../src/core/operation-identity.ts';

describe('operation identity', () => {
  test('prefers the authenticated principal and retains the technical client', () => {
    expect(operationIdentityForContext({
      remote: true,
      auth: {
        clientId: 'gbrain_cl_source_a',
        boundPrincipal: 'people/alice-example',
      },
    })).toEqual({
      actor: 'principal:people/alice-example',
      principal: 'people/alice-example',
      clientId: 'gbrain_cl_source_a',
    });
  });

  test('falls back through authenticated, stdio, and local identities', () => {
    expect(operationIdentityForContext({
      remote: true,
      auth: { clientId: 'gbrain_cl_unbound' },
    })).toEqual({
      actor: 'mcp:gbrain_cl_unbound',
      clientId: 'gbrain_cl_unbound',
    });
    expect(operationIdentityForContext({ remote: true })).toEqual({
      actor: 'mcp:stdio',
    });
    expect(operationIdentityForContext(
      { remote: false },
      'cli:custom',
    )).toEqual({
      actor: 'cli:custom',
    });
  });
});
