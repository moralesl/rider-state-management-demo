#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StateManagementASLDemoStack } from './state-management-demo-asl-stack';
import { StateManagementDemoStack } from './state-management-demo-stack';
import { Tags } from 'aws-cdk-lib';

const app = new cdk.App();
const stateManagementASLDemoStack = new StateManagementASLDemoStack(app, 'StateManagementASLDemoStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1'},
});

Tags.of(stateManagementASLDemoStack).add('Project', 'StateManagementASLDemo')


const stateManagementDemoStack = new StateManagementDemoStack(app, 'StateManagementDemoStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1'},
});

Tags.of(stateManagementDemoStack).add('Project', 'StateManagementDemo')
