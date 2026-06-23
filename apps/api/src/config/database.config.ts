import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  uri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/pinntag-dop',
  pinntagDev: process.env.PINNTAG_DEV_MONGO_URI,
  pinntagPreProd: process.env.PINNTAG_PRE_PROD_MONGO_URI,
  pinntagStaging: process.env.PINNTAG_STAGING_MONGO_URI,
  pinntagProd: process.env.PINNTAG_PROD_MONGO_URI,
}));
