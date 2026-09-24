/** Failure categories for the environment/AC module (all reject, never clamp). */
export type EnvironmentErrorCode =
  | 'INVALID_TYPE'
  | 'OUT_OF_RANGE'
  | 'UNSUPPORTED_FIELD'
  | 'UNSUPPORTED_DEVICE';

/**
 * Actionable validation error. Messages name the field, the offending value and
 * the accepted type/range so a caller can fix the input instead of guessing.
 */
export class EnvironmentInputError extends Error {
  readonly code: EnvironmentErrorCode;
  readonly field: string;

  constructor(code: EnvironmentErrorCode, field: string, message: string) {
    super(message);
    this.name = 'EnvironmentInputError';
    this.code = code;
    this.field = field;
  }
}
