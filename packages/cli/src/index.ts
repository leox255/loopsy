#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { initCommand } from './commands/init.js';
import { startCommand, stopCommand, statusCommand } from './commands/daemon.js';
import { peersCommand } from './commands/peers.js';
import { execCommand } from './commands/exec.js';
import { sendCommand, pullCommand } from './commands/transfer.js';
import { contextCommand } from './commands/context.js';
import { keyCommand } from './commands/key.js';
import { logsCommand } from './commands/logs.js';
import { connectCommand } from './commands/connect.js';

yargs(hideBin(process.argv))
  .scriptName('loopsy')
  .command('init', 'Initialize Loopsy config and generate API key', {}, initCommand)
  .command('connect', 'Interactive wizard to connect to another machine', {}, connectCommand)
  .command('start', 'Start the Loopsy daemon', {}, startCommand)
  .command('stop', 'Stop the Loopsy daemon', {}, stopCommand)
  .command('status', 'Show daemon status', {}, statusCommand)
  .command(
    'peers',
    'List known peers',
    (yargs) =>
      yargs
        .command('add <address> [port]', 'Add a manual peer', {
          address: { type: 'string', demandOption: true },
          port: { type: 'number', default: 19532 },
        })
        .command('remove <nodeId>', 'Remove a peer', {
          nodeId: { type: 'string', demandOption: true },
        }),
    peersCommand,
  )
  .command(
    'exec <peer> <cmd..>',
    'Execute a command on a remote peer',
    (yargs) =>
      yargs
        .positional('peer', { type: 'string', demandOption: true, describe: 'Peer address (host:port)' })
        .positional('cmd', { type: 'string', array: true, demandOption: true })
        .option('key', { type: 'string', alias: 'k', describe: 'API key for the peer' })
        .option('timeout', { type: 'number', alias: 't', describe: 'Timeout in ms' }),
    execCommand,
  )
  .command(
    'send <peer> <src> <dest>',
    'Push a local file to a remote peer',
    (yargs) =>
      yargs
        .positional('peer', { type: 'string', demandOption: true })
        .positional('src', { type: 'string', demandOption: true })
        .positional('dest', { type: 'string', demandOption: true })
        .option('key', { type: 'string', alias: 'k' }),
    sendCommand,
  )
  .command(
    'pull <peer> <src> <dest>',
    'Pull a file from a remote peer',
    (yargs) =>
      yargs
        .positional('peer', { type: 'string', demandOption: true })
        .positional('src', { type: 'string', demandOption: true })
        .positional('dest', { type: 'string', demandOption: true })
        .option('key', { type: 'string', alias: 'k' }),
    pullCommand,
  )
  .command(
    'context',
    'Manage shared context',
    (yargs) =>
      yargs
        .command('set <key> <value>', 'Set a context value', {
          key: { type: 'string', demandOption: true },
          value: { type: 'string', demandOption: true },
          ttl: { type: 'number', describe: 'TTL in seconds' },
        })
        .command('get <key>', 'Get a context value', {
          key: { type: 'string', demandOption: true },
        })
        .command('list', 'List all context entries')
        .command('delete <key>', 'Delete a context entry', {
          key: { type: 'string', demandOption: true },
        }),
    contextCommand,
  )
  .command(
    'key',
    'API key management',
    (yargs) =>
      yargs
        .command('generate', 'Generate a new API key')
        .command('show', 'Show current API key'),
    keyCommand,
  )
  .command(
    'logs',
    'View daemon logs',
    (yargs) => yargs.option('follow', { type: 'boolean', alias: 'f', default: false }),
    logsCommand,
  )
  .demandCommand(1, 'You need at least one command')
  .help()
  .version('1.0.0')
  .parse();
