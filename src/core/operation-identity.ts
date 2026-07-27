/** Authenticated fields used to resolve mutation attribution. */
export interface AuthenticatedOperationIdentity {
  clientId: string;
  boundPrincipal?: string;
}

/** Minimal trusted request context needed by the identity resolver. */
export interface OperationIdentityContext {
  remote: boolean;
  auth?: AuthenticatedOperationIdentity;
}

/** Human-facing attribution plus the underlying technical client identity. */
export interface OperationIdentity {
  actor: string;
  principal?: string;
  clientId?: string;
}

/**
 * Resolve server-authenticated request context into mutation attribution.
 * Caller-supplied operation parameters never participate in this decision.
 */
export function operationIdentityForContext(
  ctx: OperationIdentityContext,
  localActor = 'cli',
): OperationIdentity {
  const clientId = ctx.auth?.clientId;
  const principal = ctx.auth?.boundPrincipal;
  if (principal) {
    return {
      actor: `principal:${principal}`,
      principal,
      ...(clientId ? { clientId } : {}),
    };
  }
  if (clientId) return { actor: `mcp:${clientId}`, clientId };
  return { actor: ctx.remote !== false ? 'mcp:stdio' : localActor };
}
