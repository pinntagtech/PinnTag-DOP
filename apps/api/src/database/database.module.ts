import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('database.uri'),
        connectionFactory: (connection) => {
          connection.on('connected', () =>
            console.log('MongoDB connected: pinntag-dop'),
          );
          connection.on('error', (err) =>
            console.error('MongoDB connection error:', err),
          );
          return connection;
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
