/**
 * Portable Auth Helpers
 *
 * Higher-order wrappers for Next.js server actions:
 * - validatedAction: Zod schema validation for form data
 * - validatedActionWithUser: Same + authenticated user injection
 *
 * Source: saas-starter/lib/auth/middleware.ts
 *
 * Required deps: zod
 * Required imports: your own getUser() function
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionState = {
  error?: string;
  success?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// validatedAction -- Zod-validated server action wrapper
// ---------------------------------------------------------------------------

type ValidatedActionFunction<S extends z.ZodType, T> = (
  data: z.infer<S>,
  formData: FormData
) => Promise<T>;

/**
 * Wraps a Next.js server action with Zod form validation.
 *
 * Usage:
 * ```ts
 * const schema = z.object({ email: z.string().email() });
 * export const myAction = validatedAction(schema, async (data, formData) => {
 *   // data.email is typed and validated
 * });
 * ```
 */
export function validatedAction<S extends z.ZodType, T>(
  schema: S,
  action: ValidatedActionFunction<S, T>
) {
  return async (prevState: ActionState, formData: FormData) => {
    const result = schema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
      return { error: result.error.errors[0].message };
    }
    return action(result.data, formData);
  };
}

// ---------------------------------------------------------------------------
// validatedActionWithUser -- Validated + authenticated
// ---------------------------------------------------------------------------

/**
 * Generic user type. Replace with your own User type.
 * Must have at least an `id` field.
 */
export type AuthUser = {
  id: number;
  [key: string]: unknown;
};

type GetUserFn = () => Promise<AuthUser | null>;

type ValidatedActionWithUserFunction<S extends z.ZodType, T, U extends AuthUser> = (
  data: z.infer<S>,
  formData: FormData,
  user: U
) => Promise<T>;

/**
 * Creates a validatedActionWithUser wrapper using your own getUser function.
 *
 * Usage:
 * ```ts
 * import { getUser } from '@/lib/db/queries';
 * const validatedActionWithUser = createValidatedActionWithUser(getUser);
 *
 * export const updatePassword = validatedActionWithUser(schema, async (data, formData, user) => {
 *   // user is guaranteed to be authenticated
 * });
 * ```
 */
export function createValidatedActionWithUser<U extends AuthUser>(getUserFn: GetUserFn) {
  return function validatedActionWithUser<S extends z.ZodType, T>(
    schema: S,
    action: ValidatedActionWithUserFunction<S, T, U>
  ) {
    return async (prevState: ActionState, formData: FormData) => {
      const user = await getUserFn();
      if (!user) {
        throw new Error('User is not authenticated');
      }
      const result = schema.safeParse(Object.fromEntries(formData));
      if (!result.success) {
        return { error: result.error.errors[0].message };
      }
      return action(result.data, formData, user as U);
    };
  };
}
