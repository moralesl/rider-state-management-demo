import * as path from "path";

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { Choice, Condition, JsonPath } from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";

export class StateManagementDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const riderStateTable = new dynamodb.Table(this, "RiderStateTable-CDK", {
      partitionKey: { name: "Area#Entity", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableName: "RiderStateTable-CDK",

      removalPolicy: RemovalPolicy.DESTROY, // This is just for development purposes
    });

    riderStateTable.addGlobalSecondaryIndex({
      indexName: "State",
      partitionKey: { name: "State", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "Area#Entity", type: dynamodb.AttributeType.STRING },

      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 1. Get current rider state informations
    const getCurrentRiderStateInformation = new tasks.DynamoGetItem(this, "Get current rider state", {
      table: riderStateTable,
      key: {
        "Area#Entity": tasks.DynamoAttributeValue.fromString(JsonPath.stringAt("$.input.rider_id")),
      },
      resultSelector: {
        "rider_id.$": "$.Item.Area#Entity.S",
        "timestamp.$": "$.Item.Timestamp.N",
        "state.$": "$.Item.State.S",
        "lat.$": "$.Item.Lat.N",
        "long.$": "$.Item.Long.N",
      },
      resultPath: "$.rider",
    }).addRetry({
      maxAttempts: 3,
      interval: Duration.seconds(1),
      backoffRate: 1.5,
    });

    // 2. Validate starting point
    const validateStartPoint = new tasks.LambdaInvoke(this, "Validate start point and device token", {
      lambdaFunction: new lambda.Function(this, "RiderStateValidation-CDK", {
        functionName: "RiderStateValidation-CDK",
        runtime: lambda.Runtime.PYTHON_3_9,
        architecture: lambda.Architecture.ARM_64,
        handler: "app.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "..", "rider-state-validation")),
      }),
      payload: sfn.TaskInput.fromJsonPathAt("$"),
      resultSelector: {
        "statusCode.$": "$.Payload.statusCode",
        "valid.$": "$.Payload.valid",
      },
      resultPath: "$.validator",
    }).addRetry({
      maxAttempts: 5,
      interval: Duration.seconds(1),
      backoffRate: 1.5,
    });

    // 3. Transition rider to next state & persist it
    const transitionRiderToNextStateAndPersistIt = new tasks.DynamoUpdateItem(this, "Transition rider to next state", {
      table: riderStateTable,
      key: {
        "Area#Entity": tasks.DynamoAttributeValue.fromString(JsonPath.stringAt("$.input.rider_id")),
      },
      updateExpression: "SET #state = :nextState",
      expressionAttributeNames: {
        "#state": "State",
      },
      expressionAttributeValues: {
        ":nextState": tasks.DynamoAttributeValue.fromString(JsonPath.stringAt("$.input.next_state")),
      },
      resultSelector: {
        "status_code.$": "$.SdkHttpMetadata.HttpStatusCode",
      },
      resultPath: "$.ddb",
    }).addRetry({
      maxAttempts: 5,
      interval: Duration.seconds(1),
      backoffRate: 1.5,
    });

    // 4. Emit rider state change information
    const emitRiderStateChangeEvent = new tasks.SnsPublish(this, "Emit rider state change event", {
      topic: new sns.Topic(this, "RiderStateChangeEvent-CDK", {
        displayName: "RiderStateChangeEvent-CDK",
        topicName: "RiderStateChangeEvent-CDK",
      }),
      message: sfn.TaskInput.fromJsonPathAt("$"),
      resultSelector: {
        "status_code.$": "$.SdkHttpMetadata.HttpStatusCode",
      },
      resultPath: "$.sns",
    }).addRetry({
      maxAttempts: 5,
      interval: Duration.seconds(1),
      backoffRate: 1.5,
    });

    // On error send event to DLQ
    const sendEventToDlqForManualHandling = new tasks.SqsSendMessage(this, "Send event to DLQ for manual handling", {
      queue: new sqs.Queue(this, "RiderStateDLQ-CDK", {
        queueName: "RiderStateDLQ-CDK",
        retentionPeriod: Duration.minutes(5),

        removalPolicy: RemovalPolicy.DESTROY, // This is just for development purposes
      }),
      messageBody: sfn.TaskInput.fromJsonPathAt("$"),
    })
      .addRetry({
        maxAttempts: 5,
        interval: Duration.seconds(1),
        backoffRate: 1.5,
      })
      .next(new sfn.Fail(this, "State Transition Failed", {}));

    const riderStateTransitionManagementStateMachineDefinition = new Choice(this, "Is rider id and next state valid?")
      .when(
        // Check if input is valid
        Condition.and(
          ...allArePresent("$.input.rider_id", "$.input.next_state"),
          anyStringMatches("$.input.next_state", "Not Working", "Available", "Starting", "Working")
        ),
        // Get current rider state information
        getCurrentRiderStateInformation.next(
          new Choice(this, "Is next state a valid transition?")
            .when(
              // If it transitions from starting to working...
              isValidStateTransition({
                currentStateVariable: "$.rider.state",
                nextStateVariable: "$.input.next_state",
                validTransitions: [["Starting", "Working"]],
              }),
              // Validate the start point and transition the rider to the next state
              validateStartPoint.next(transitionRiderToNextStateAndPersistIt)
            )
            .when(
              // If it is another valid transition...
              isValidStateTransition({
                currentStateVariable: "$.rider.state",
                nextStateVariable: "$.input.next_state",
                validTransitions: [
                  ["Not Working", "Available"],
                  ["Not Working", "Starting"],
                  ["Available", "Not Working"],
                  ["Available", "Starting"],
                  ["Starting", "Not Working"],
                  ["Working", "Not Working"],
                ],
              }),
              // Transition the rider to the next state and emit change event
              transitionRiderToNextStateAndPersistIt.next(emitRiderStateChangeEvent)
            )
            // Otherwise send event to DLQ
            .otherwise(sendEventToDlqForManualHandling)
        )
      )
      // Otherwise send event to DLQ
      .otherwise(sendEventToDlqForManualHandling);

    const riderStateTransitionManagementStateMachine = new sfn.StateMachine(
      this,
      "RiderStateTransitionManagement-CDK",
      {
        definitionBody: sfn.DefinitionBody.fromChainable(riderStateTransitionManagementStateMachineDefinition),
        stateMachineName: "RiderStateTransitionManagement-CDK",
        stateMachineType: sfn.StateMachineType.EXPRESS,
        tracingEnabled: true,
        logs: {
          destination: new logs.LogGroup(this, "RiderStateTransitionManagement-CDK-LogGroup"),
          level: sfn.LogLevel.ALL,
          includeExecutionData: true,
        },
      }
    );

    riderStateTable.grantReadWriteData(riderStateTransitionManagementStateMachine);

    new CfnOutput(this, "RiderStateTransitionManagementStateMachine-Arn", {
      value: riderStateTransitionManagementStateMachine.stateMachineArn,
    });
  }
}

const allArePresent = (...fieldsToBePresent: string[]): Condition[] => {
  return fieldsToBePresent.map((fieldToBePresent) => Condition.isPresent(fieldToBePresent));
};

const anyStringMatches = (fieldToCheck: string, ...possibleMatches: string[]): Condition => {
  return Condition.or(...possibleMatches.map((possibleMatch) => Condition.stringEquals(fieldToCheck, possibleMatch)));
};

const isValidStateTransition = (config: {
  currentStateVariable: string;
  nextStateVariable: string;
  validTransitions: string[][];
}): Condition => {
  return Condition.or(
    ...config.validTransitions.map((validTransition) =>
      Condition.and(
        Condition.stringEquals(config.currentStateVariable, validTransition[0]),
        Condition.stringEquals(config.nextStateVariable, validTransition[1])
      )
    )
  );
};
