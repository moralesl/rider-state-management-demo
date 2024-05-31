import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { StateManagementDemoStack } from '../cdk/state-management-demo-stack';

test('CDK Demo match Snapshot', () => {
    const app = new App();
    const stack = new StateManagementDemoStack(app, 'StateManagementDemoStack');

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
});