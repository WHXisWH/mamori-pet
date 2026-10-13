import type { PubSubTopic } from '@ijime/api-types';
import { outbound } from '@ijime/config';

import { eventSchemas, type EventPayload } from './events.js';
import { AdcGoogleHttp, PlainHttp, type GoogleHttp } from './google-http.js';

export interface Publisher {
  publish<T extends PubSubTopic>(topic: T, payload: EventPayload<T>): Promise<void>;
}

// トピック名は Terraform と同じ。ドットをハイフンに置き換える
export function topicResourceName(topic: PubSubTopic): string {
  return topic.replace(/\./g, '-');
}

function validated<T extends PubSubTopic>(topic: T, payload: unknown): EventPayload<T> {
  return eventSchemas[topic].parse(payload) as EventPayload<T>;
}

export class MemoryPublisher implements Publisher {
  readonly published: { topic: PubSubTopic; payload: Record<string, unknown> }[] = [];

  async publish<T extends PubSubTopic>(topic: T, payload: EventPayload<T>): Promise<void> {
    this.published.push({ topic, payload: validated(topic, payload) as Record<string, unknown> });
  }

  of<T extends PubSubTopic>(topic: T): EventPayload<T>[] {
    return this.published.filter((p) => p.topic === topic).map((p) => p.payload as never);
  }
}

export class PubSubRestPublisher implements Publisher {
  private readonly base: string;

  constructor(
    private readonly projectId: string,
    private readonly http: GoogleHttp,
    emulatorHost?: string,
  ) {
    this.base = emulatorHost ? `http://${emulatorHost}/v1` : 'https://pubsub.googleapis.com/v1';
  }

  static fromEnv(projectId: string, env: NodeJS.ProcessEnv = process.env): PubSubRestPublisher {
    const emulator = env['PUBSUB_EMULATOR_HOST'];
    return new PubSubRestPublisher(
      projectId,
      emulator ? new PlainHttp() : new AdcGoogleHttp(),
      emulator,
    );
  }

  async publish<T extends PubSubTopic>(topic: T, payload: EventPayload<T>): Promise<void> {
    const data = Buffer.from(JSON.stringify(validated(topic, payload))).toString('base64');
    await this.http.request({
      url: `${this.base}/projects/${this.projectId}/topics/${topicResourceName(topic)}:publish`,
      method: 'POST',
      body: { messages: [{ data }] },
      timeoutMs: outbound.googleApiTimeoutMs,
    });
  }
}
