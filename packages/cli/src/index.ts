#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { initCommand } from './commands/init.js';
import { startCommand, stopCommand, restartCommand, statusCommand } from './commands/daemon.js';
import { peersListCommand, peersAddCommand, peersRemoveCommand } from './commands/peers.js';
import { execCommand } from './commands/exec.js';
import { sendCommand, pullCommand } from './commands/transfer.js';
import { contextSetCommand, contextGetCommand, contextListCommand, contextDeleteCommand } from './commands/context.js';
import { keyGenerateCommand, keyShowCommand } from './commands/key.js';
import { logsCommand } from './commands/logs.js';
import { connectCommand } from './commands/connect.js';
import {
  sessionCommand,
  sessionStartCommand,
  sessionStartFleetCommand,
  sessionStopCommand,
  sessionStopAllCommand,
  sessionListCommand,
  sessionStatusCommand,
  sessionRemoveCommand,
} from './commands/session.js';
import { dashboardCommand } from './commands/dashboard.js';
import { enableCommand, disableCommand, serviceStatusCommand } from './commands/service.js';
import { mcpAddCommand, mcpRemoveCommand, mcpStatusCommand } from './commands/mcp.js';
import { pairCommand } from './commands/pair.js';
import { doctorCommand } from './commands/doctor.js';
import { updateCommand } from './commands/update.js';

yargs(hideBin(process.argv))
  .scriptName('loopsy')
  .command('init', 'Initialize Loopsy config and generate API key', {}, initCommand)
  .command('connect', 'Interactive wizard to connect to another machine', {}, connectCommand)
  .command('start', 'Start the Loopsy daemon', {}, startCommand)
  .command('stop', 'Stop the Loopsy daemon', {}, stopCommand)
  .command('restart', 'Restart the Loopsy daemon', {}, restartCommand)
  .command('status', 'Show daemon status', {}, statusCommand)
  .command(
    'peers',
    'List known peers',
    (yargs) =>
      yargs
        .command('add <address> [port]', 'Add a manual peer', {
          address: { type: 'string', demandOption: true },
          port: { type: 'number', default: 19532 },
        }, peersAddCommand)
        .command('remove <nodeId>', 'Remove a peer', {
          nodeId: { type: 'string', demandOption: true },
        }, peersRemoveCommand),
    peersListCommand,
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
        }, contextSetCommand)
        .command('get <key>', 'Get a context value', {
          key: { type: 'string', demandOption: true },
        }, contextGetCommand)
        .command('list', 'List all context entries', {}, contextListCommand)
        .command('delete <key>', 'Delete a context entry', {
          key: { type: 'string', demandOption: true },
        }, contextDeleteCommand)
        .demandCommand(1),
    () => {},
  )
  .command(
    'key',
    'API key management',
    (yargs) =>
      yargs
        .command('generate', 'Generate a new API key', {}, keyGenerateCommand)
        .command('show', 'Show current API key', {}, keyShowCommand)
        .demandCommand(1),
    () => {},
  )
  .command(
    'logs',
    'View daemon logs',
    (yargs) => yargs.option('follow', { type: 'boolean', alias: 'f', default: false }),
    logsCommand,
  )
  .command(
    'session',
    'Manage daemon sessions',
    (yargs) =>
      yargs
        .command(
          'start <name>',
          'Start a named session',
          (y: any) => y.positional('name', { type: 'string', demandOption: true, describe: 'Session name' }),
          sessionStartCommand,
        )
        .command(
          'start-fleet',
          'Start multiple worker sessions',
          (y: any) => y.option('count', { type: 'number', alias: 'c', default: 3, describe: 'Number of sessions' }),
          sessionStartFleetCommand,
        )
        .command(
          'stop <name>',
          'Stop a named session',
          (y: any) => y.positional('name', { type: 'string', demandOption: true }),
          sessionStopCommand,
        )
        .command('stop-all', 'Stop all sessions', {}, sessionStopAllCommand)
        .command('list', 'List all sessions', {}, sessionListCommand)
        .command(
          'status <name>',
          'Show status for a session',
          (y: any) => y.positional('name', { type: 'string', demandOption: true }),
          sessionStatusCommand,
        )
        .command(
          'remove <name>',
          'Remove a stopped session and its data',
          (y: any) => y.positional('name', { type: 'string', demandOption: true }),
          sessionRemoveCommand,
        )
        .demandCommand(1),
    sessionCommand,
  )
  .command(
    'dashboard',
    'Open the web dashboard (served by the daemon)',
    {},
    dashboardCommand,
  )
  .command(
    'pair [address]',
    'Pair with another machine (run without address to wait, or with address to connect)',
    (yargs) =>
      yargs.positional('address', { type: 'string', describe: 'Peer address (host or host:port)' }),
    pairCommand,
  )
  .command('enable', 'Register daemon as a system service (auto-start on login)', {}, enableCommand)
  .command('disable', 'Unregister daemon from system service', {}, disableCommand)
  .command('service-status', 'Check system service registration status', {}, serviceStatusCommand)
  .command(
    'mcp',
    'Manage MCP server registration with Claude Code',
    (yargs) =>
      yargs
        .command('add', 'Register MCP server with Claude Code', {}, mcpAddCommand)
        .command('remove', 'Unregister MCP server from Claude Code', {}, mcpRemoveCommand)
        .command('status', 'Check MCP server registration', {}, mcpStatusCommand)
        .demandCommand(1),
    () => {},
  )
  .command('update', 'Update Loopsy to the latest version', {}, updateCommand)
  .command('doctor', 'Run health checks on your Loopsy installation', {}, doctorCommand)
  .demandCommand(1, 'You need at least one command')
  .help()
  .version('1.0.19')
  .parse();
