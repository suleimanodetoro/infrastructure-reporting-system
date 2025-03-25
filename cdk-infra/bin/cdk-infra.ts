#!/usr/bin/env node
// File: cdk-infra/bin/cdk-infra.ts

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AmplifyInfrastructureStack } from '../lib/stacks/amplify-infrastructure-stack';

const app = new cdk.App();

// Environment configuration
const env = { 
  account: process.env.CDK_DEFAULT_ACCOUNT, 
  region: process.env.CDK_DEFAULT_REGION || 'eu-west-2'
};

// Tags that will be applied to all resources
const tags = {
  Project: 'CommunitySafetyPlatform',
  Environment: 'Development', // Change for staging/production
  Owner: 'InfraTeam'
};

// Create the infrastructure stack using Amplify
const amplifyInfraStack = new AmplifyInfrastructureStack(app, 'SafetyPlatform-Amplify-Dev', { 
  env,
  description: 'Core infrastructure with Amplify for the Community Safety Intelligence Platform',
});

// Apply tags to all resources in all stacks
for (const [key, value] of Object.entries(tags)) {
  cdk.Tags.of(app).add(key, value);
}