const [, , cmd] = process.argv;

if (cmd === undefined || cmd === 'help' || cmd === '--help') {
  process.stdout.write('mcprouter <command>\n\n  help    show this message\n');
  process.exit(0);
}

process.stderr.write(`unknown command: ${cmd}\n`);
process.exit(1);
