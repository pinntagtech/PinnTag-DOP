import mongoose from 'mongoose';
import { Exceptions } from '../errors/exceptions';

export function validateObjectId(value: string, field: string): void {
  if (!mongoose.isValidObjectId(value)) {
    throw Exceptions.invalidObjectId(field, value);
  }
}

export function toObjectId(
  value: string,
  field: string,
): mongoose.Types.ObjectId {
  validateObjectId(value, field);
  return new mongoose.Types.ObjectId(value);
}
