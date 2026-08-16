// Thin wrapper around the AWS EC2 SDK — hardcoded to the single GPU/
// Ollama instance that backs the judgment pipeline. Instance ID is a
// module constant, not a parameter, so no caller can ever redirect
// this at a different instance by accident or on purpose.
//
// Credentials are taken from the standard AWS SDK provider chain
// (env vars → shared credentials file → EC2 instance metadata role).
// In production the DOP API EC2 (107.23.203.205) should have an
// IAM role attached with the minimal policy documented in
// gpu-control.controller.ts (three EC2 actions scoped to this
// instance). No access keys should be checked in or set as env vars.
//
// Region defaults to us-east-1 (the DOP + GPU instances live there).
// Override with AWS_REGION env var if that ever changes.

import { Injectable, Logger } from '@nestjs/common';
import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';

export const GPU_INSTANCE_ID = 'i-01a1215af34b1e95f';

@Injectable()
export class GpuControlService {
  private readonly logger = new Logger(GpuControlService.name);
  private readonly client = new EC2Client({
    region: process.env.AWS_REGION || 'us-east-1',
  });

  // Returns the instance State.Name — one of pending | running |
  // shutting-down | terminated | stopping | stopped | unknown.
  // Awaited by the caller (status is the whole point of the call).
  async status(): Promise<string> {
    const res = await this.client.send(
      new DescribeInstancesCommand({ InstanceIds: [GPU_INSTANCE_ID] }),
    );
    const inst = res.Reservations?.[0]?.Instances?.[0];
    const state = inst?.State?.Name || 'unknown';
    return state;
  }

  // Fire-and-forget from the controller's POV — start-instances
  // returns immediately with the state transition ('pending') but
  // the instance itself takes ~60-120s to reach 'running'. The
  // controller acks Slack in <3s and does NOT await this.
  async start(): Promise<void> {
    await this.client.send(
      new StartInstancesCommand({ InstanceIds: [GPU_INSTANCE_ID] }),
    );
    this.logger.log(`start-instances issued for ${GPU_INSTANCE_ID}`);
  }

  async stop(): Promise<void> {
    await this.client.send(
      new StopInstancesCommand({ InstanceIds: [GPU_INSTANCE_ID] }),
    );
    this.logger.log(`stop-instances issued for ${GPU_INSTANCE_ID}`);
  }
}
