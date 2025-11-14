#!/usr/bin/env node

// Test script to verify AWS credential detection works without environment variables

const { checkAWSCredentials, getAWSConfigInfo } = require('./dist/lib/ai-commit');
const chalk = require('chalk');

async function testAWSCredentials() {
  console.log(chalk.blue('Testing AWS Credential Detection\n'));

  // Show current configuration
  const configInfo = await getAWSConfigInfo();
  console.log(chalk.cyan('Current AWS Configuration:'));
  console.log(`  Region: ${chalk.yellow(configInfo.region)}`);
  console.log(`  Model: ${chalk.yellow(configInfo.model)}`);

  // Check if AWS credentials are available
  console.log(chalk.cyan('\nChecking AWS credentials...'));

  const credentialsAvailable = await checkAWSCredentials();

  if (credentialsAvailable) {
    console.log(chalk.green('✓ AWS credentials are configured and valid!'));
    console.log(chalk.gray('\nThe AI commit feature should work. Credentials can come from:'));
    console.log(chalk.gray('  - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)'));
    console.log(chalk.gray('  - AWS credentials file (~/.aws/credentials)'));
    console.log(chalk.gray('  - AWS config file (~/.aws/config with AWS_PROFILE)'));
    console.log(chalk.gray('  - EC2/ECS instance roles'));
    console.log(chalk.gray('  - AWS SSO'));
  } else {
    console.log(chalk.red('✗ AWS credentials are not configured or invalid'));
    console.log(chalk.yellow('\nTo configure AWS credentials, you can:'));
    console.log(chalk.gray('1. Run: aws configure'));
    console.log(chalk.gray('2. Set environment variables:'));
    console.log(chalk.gray('   export AWS_ACCESS_KEY_ID=your-key'));
    console.log(chalk.gray('   export AWS_SECRET_ACCESS_KEY=your-secret'));
    console.log(chalk.gray('3. Use AWS profiles:'));
    console.log(chalk.gray('   export AWS_PROFILE=your-profile'));
    console.log(chalk.gray('4. Configure AWS SSO'));
  }

  console.log(chalk.blue('\n✓ Test complete'));
}

// Run the test
testAWSCredentials().catch(error => {
  console.error(chalk.red('Error during testing:'), error);
  process.exit(1);
});