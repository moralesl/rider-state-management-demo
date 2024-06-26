import * as path from "path";

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";

export class StateManagementASLDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const riderStateValidation = new lambda.Function(this, "RiderStateValidation-ASL-CDK", {
      functionName: "RiderStateValidation-ASL-CDK",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "app.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "rider-state-validation")),
    });

    const riderStateChangeEvent = new sns.Topic(this, "RiderStateChangeEvent-ASL-CDK", {
      displayName: "RiderStateChangeEvent-ASL-CDK",
      topicName: "RiderStateChangeEvent-ASL-CDK",
    });

    const riderStateDLQ = new sqs.Queue(this, "RiderStateDLQ-ASL-CDK", {
      queueName: "RiderStateDLQ-ASL-CDK",
      retentionPeriod: Duration.minutes(5),

      removalPolicy: RemovalPolicy.DESTROY, // This is just for development purposes
    });

    const riderStateTable = new dynamodb.Table(this, "RiderStateTable-ASL-CDK", {
      partitionKey: { name: "Area#Entity", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableName: "RiderStateTable-ASL-CDK",

      removalPolicy: RemovalPolicy.DESTROY, // This is just for development purposes
    });

    riderStateTable.addGlobalSecondaryIndex({
      indexName: "State",
      partitionKey: { name: "State", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "Area#Entity", type: dynamodb.AttributeType.STRING },

      projectionType: dynamodb.ProjectionType.ALL,
    });

    const riderStateTransitionManagementStateMachine = new sfn.StateMachine(
      this,
      "RiderStateTransitionManagement-ASL-CDK",
      {
        definitionBody: sfn.DefinitionBody.fromFile("rider-state-management.asl.json"),
        definitionSubstitutions: {
          QUEUE_URL: riderStateDLQ.queueUrl,
          TABLE_NAME: riderStateTable.tableName,
          TOPIC_ARN: riderStateChangeEvent.topicArn,
          FUNCTION_ARN: riderStateValidation.functionArn
        },

        stateMachineName: "RiderStateTransitionManagement-ASL-CDK",
        stateMachineType: sfn.StateMachineType.EXPRESS,
        tracingEnabled: true,
        logs: {
          destination: new logs.LogGroup(this, "RiderStateTransitionManagement-ASL-CDK-LogGroup"),
          level: sfn.LogLevel.ALL,
          includeExecutionData: true,
        },
      }
    );

    riderStateValidation.grantInvoke(riderStateTransitionManagementStateMachine);
    riderStateChangeEvent.grantPublish(riderStateTransitionManagementStateMachine);
    riderStateDLQ.grantSendMessages(riderStateTransitionManagementStateMachine);
    riderStateTable.grantReadWriteData(riderStateTransitionManagementStateMachine);

    new CfnOutput(this, "RiderStateTransitionManagementStateMachine-ASL-Arn", {
      value: riderStateTransitionManagementStateMachine.stateMachineArn,
    });
  }
}
