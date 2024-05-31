import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { StateManagementASLDemoStack } from '../cdk/state-management-demo-asl-stack';

test('ASL Demo match Snapshot', () => {
  const app = new App();
  const stack = new StateManagementASLDemoStack(app, 'StateManagementASLDemoStack');

  const template = Template.fromStack(stack);
  expect(template.toJSON()).toMatchSnapshot();
});
