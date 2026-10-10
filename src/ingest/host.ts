import { AppError } from '../contracts/index.ts';
export function agreementWording(): { version: number; text: string } {
  throw new AppError('invalid', 'not built: agreementWording');
}

export { createHost } from './spine.ts';
