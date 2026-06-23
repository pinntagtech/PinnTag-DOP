import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import { DatabaseModule } from './database/database.module';
import { BusinessModule } from './modules/business/business.module';
import { BusinessUserModule } from './modules/business-user/business-user.module';
import { OutletModule } from './modules/outlet/outlet.module';
import { EventModule } from './modules/event/event.module';
import { EventLocationModule } from './modules/event-location/event-location.module';
import { EventScheduleModule } from './modules/event-schedule/event-schedule.module';
import { MenuModule } from './modules/menu/menu.module';
import { MediaModule } from './modules/media/media.module';
import { SeedingModule } from './modules/seeding/seeding.module';
import { AuthModule } from './modules/auth/auth.module';
import { LocationsModule } from './modules/locations/locations.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig],
      envFilePath: '.env',
    }),
    DatabaseModule,
    AuthModule,
    BusinessModule,
    BusinessUserModule,
    OutletModule,
    EventModule,
    EventLocationModule,
    EventScheduleModule,
    MenuModule,
    MediaModule,
    LocationsModule,
    SeedingModule,
  ],
})
export class AppModule {}
