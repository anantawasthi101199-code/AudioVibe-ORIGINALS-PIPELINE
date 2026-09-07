/**
 * The Foundry command line.
 *
 * Every stage is reachable on its own, deliberately. A pipeline you can only
 * run end to end is a pipeline you cannot debug: when an episode comes out
 * wrong the question is always "which stage did that", and the answer should be
 * a command rather than an afternoon.
 */
const USAGE = `
AudioVibe Foundry

  npm run foundry -- <command> [options]

Commands
  (none yet)

Nothing is wired up yet. See CHANGELOG.md for what exists.
`;

export const run = (argv: string[]): number => {
  const [command] = argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE.trim());
    return 0;
  }

  console.error(`Unknown command: ${command}\n`);
  console.error(USAGE.trim());
  return 1;
};

/* istanbul ignore next -- entry point, exercised by running it */
if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
