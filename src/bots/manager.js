import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { BotInstance } from './instance.js';

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class BotManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.instances = new Map();
  }

  restoreFromStore() {
    for (const bot of this.store.list()) {
      this._wrap(bot);
    }
  }

  list() {
    return [...this.instances.values()];
  }

  get(id) {
    return this.instances.get(id);
  }

  serialize() {
    return this.list().map((i) => i.toJSON());
  }

  create(input) {
    const validated = this._validate(input, /* partial */ false);
    const now = new Date().toISOString();
    const record = {
      id: nanoid(10),
      name: validated.name,
      host: validated.host,
      port: validated.port ?? 25565,
      version: validated.version || '1.21.4',
      auth: validated.auth || 'offline',
      autoStart: !!validated.autoStart,
      // Optional experiment config — consumed by BotInstance/Brain (foraging
      // scenarios set these; normal bots leave them undefined).
      ...(validated.persona != null ? { persona: validated.persona } : {}),
      ...(validated.systemPromptOverride != null ? { systemPromptOverride: validated.systemPromptOverride } : {}),
      ...(validated.chatRethinkGapMs != null ? { chatRethinkGapMs: validated.chatRethinkGapMs } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsert(record);
    const instance = this._wrap(record);
    this.emit('upsert', instance);
    return instance;
  }

  update(id, patch) {
    const instance = this.instances.get(id);
    if (!instance) return null;
    const validated = this._validate(patch, /* partial */ true);
    const next = {
      ...instance.bot,
      ...validated,
      updatedAt: new Date().toISOString(),
    };
    instance.bot = next;
    this.store.upsert(next);
    this.emit('upsert', instance);
    return instance;
  }

  async remove(id) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    try {
      await instance.disconnect();
    } catch {
      // best effort — bot might already be dead
    }
    this.instances.delete(id);
    this.store.remove(id);
    this.emit('delete', id);
    return true;
  }

  async disconnectAll() {
    await Promise.allSettled(this.list().map((i) => i.disconnect()));
  }

  _wrap(record) {
    const instance = new BotInstance(record);
    instance.on('change',     () => this.emit('upsert', instance));
    instance.on('chat',          (entry) => this.emit('chat', entry));
    instance.on('decision',      (entry) => this.emit('decision', entry));
    instance.on('brain-event',   (entry) => this.emit('brain-event', entry));
    instance.on('memory-update', (entry) => this.emit('memory-update', entry));
    this.instances.set(record.id, instance);
    return instance;
  }

  _validate(input, partial) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('body must be an object');
    }
    const out = {};

    if ('name' in input) {
      if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) {
        throw new ValidationError('name must be 3-16 chars: letters, digits, underscore');
      }
      out.name = input.name;
    } else if (!partial) {
      throw new ValidationError('name is required');
    }

    if ('host' in input) {
      if (typeof input.host !== 'string' || input.host.trim().length === 0) {
        throw new ValidationError('host is required');
      }
      out.host = input.host.trim();
    } else if (!partial) {
      throw new ValidationError('host is required');
    }

    if ('port' in input && input.port != null && input.port !== '') {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ValidationError('port must be an integer between 1 and 65535');
      }
      out.port = port;
    }

    if ('version' in input && input.version != null) {
      if (typeof input.version !== 'string') {
        throw new ValidationError('version must be a string');
      }
      out.version = input.version.trim() || '1.21.4';
    }

    if ('auth' in input && input.auth != null) {
      if (typeof input.auth !== 'string' || !AUTH_VALUES.has(input.auth)) {
        throw new ValidationError("auth must be 'offline' or 'microsoft'");
      }
      out.auth = input.auth;
    }

    if ('autoStart' in input && input.autoStart != null) {
      out.autoStart = !!input.autoStart;
    }

    if ('persona' in input && input.persona != null) {
      if (typeof input.persona !== 'string') throw new ValidationError('persona must be a string');
      out.persona = input.persona;
    }

    if ('systemPromptOverride' in input && input.systemPromptOverride != null) {
      if (typeof input.systemPromptOverride !== 'string') throw new ValidationError('systemPromptOverride must be a string');
      out.systemPromptOverride = input.systemPromptOverride;
    }

    if ('chatRethinkGapMs' in input && input.chatRethinkGapMs != null) {
      const g = Number(input.chatRethinkGapMs);
      if (!Number.isInteger(g) || g < 0) throw new ValidationError('chatRethinkGapMs must be a non-negative integer');
      out.chatRethinkGapMs = g;
    }

    return out;
  }
}

const AUTH_VALUES = new Set(['offline', 'microsoft']);
