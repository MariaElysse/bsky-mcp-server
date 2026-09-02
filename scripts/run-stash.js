import { execSync } from 'node:child_process';
try {
  execSync('git stash pop', { stdio: 'inherit' });
  console.log('Stash applied successfully');
} catch (err) {
  console.error('Stash apply error:', err);
}
