import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = new cdk.App();
const region = String(app.node.tryGetContext('fleetflowRegion') ?? 'ap-south-2');
const adminEmail = String(app.node.tryGetContext('adminEmail') ?? 'admin@fleetflow.local');
const budgetEmail = process.env.FLEETFLOW_BUDGET_EMAIL ?? app.node.tryGetContext('budgetEmail');
const budgetUsd = Number(app.node.tryGetContext('monthlyBudgetUsd') ?? 25);
const teardownAt = process.env.FLEETFLOW_TEARDOWN_AT ?? app.node.tryGetContext('teardownAt');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new Error('Set a valid adminEmail CDK context value');
if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('monthlyBudgetUsd must be positive');
if (budgetEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(budgetEmail))) throw new Error('budgetEmail must be a valid email');
if (teardownAt && (typeof teardownAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(teardownAt) || Number.isNaN(Date.parse(teardownAt)))) {
  throw new Error('teardownAt must be a UTC timestamp such as 2026-10-02T18:00:00Z');
}

class FleetFlowStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // No NAT gateway: the single application task gets outbound access through a public subnet.
    // The load balancer, PostgreSQL, and Valkey remain in isolated subnets.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'app', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', { vpc, allowAllOutbound: true });
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', { vpc });
    const cacheSecurityGroup = new ec2.SecurityGroup(this, 'CacheSecurityGroup', { vpc });
    const albSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', { vpc });
    dbSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(5432));
    cacheSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(6379));
    appSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(3000));
    appSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(3001));
    albSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80));
    // AWS-managed CloudFront origin-facing prefix list for ap-south-2 VPC origins.
    albSecurityGroup.addIngressRule(ec2.Peer.prefixList('pl-0a25c3463226fcc61'), ec2.Port.tcp(80));

    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      credentials: rds.Credentials.fromGeneratedSecret('fleetflow'),
      databaseName: 'fleetflow',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      multiAz: false,
      publiclyAccessible: false,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(1),
      deleteAutomatedBackups: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cacheSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED });
    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'Private FleetFlow Valkey subnets',
      subnetIds: cacheSubnets.subnetIds,
    });
    const cache = new elasticache.CfnReplicationGroup(this, 'Cache', {
      replicationGroupDescription: 'FleetFlow hot location state and pub-sub',
      engine: 'valkey',
      engineVersion: '7.2',
      cacheNodeType: 'cache.t4g.micro',
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      multiAzEnabled: false,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      cacheSubnetGroupName: cacheSubnetGroup.ref,
      securityGroupIds: [cacheSecurityGroup.securityGroupId],
      port: 6379,
    });
    cache.addResourceDependency(cacheSubnetGroup);

    const queue = (name: string) => {
      const dead = new sqs.Queue(this, `${name}DeadQueue`, {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        retentionPeriod: cdk.Duration.days(14),
      });
      const live = new sqs.Queue(this, `${name}Queue`, {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        visibilityTimeout: cdk.Duration.seconds(120),
        deadLetterQueue: { queue: dead, maxReceiveCount: 5 },
      });
      new cloudwatch.Alarm(this, `${name}DeadAlarm`, {
        metric: dead.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      return { live, dead };
    };
    const assignment = queue('Assignment');
    const notification = queue('Notification');
    const bus = new events.EventBus(this, 'EventBus', { eventBusName: 'fleetflow' });
    new events.Rule(this, 'NotificationRule', {
      eventBus: bus,
      eventPattern: { source: ['fleetflow'] },
      targets: [new targets.SqsQueue(notification.live)],
    });

    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
    const adminPassword = new secretsmanager.Secret(this, 'AdminPassword', {
      generateSecretString: { passwordLength: 24, excludePunctuation: true },
    });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const task = new ecs.FargateTaskDefinition(this, 'ApplicationTask', {
      cpu: 512,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const sharedEnvironment = {
      PGHOST: database.dbInstanceEndpointAddress,
      PGPORT: database.dbInstanceEndpointPort,
      PGDATABASE: 'fleetflow',
      PGUSER: 'fleetflow',
      PGSSLROOTCERT: '/app/apps/api/certs/ap-south-2-bundle.pem',
      REDIS_URL: cdk.Fn.join('', ['rediss://', cache.attrPrimaryEndPointAddress, ':6379']),
    };
    const sharedSecrets = { PGPASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password') };
    const apiImage = ecs.ContainerImage.fromAsset(root, { file: 'apps/api/Dockerfile', platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64 });
    const webImage = ecs.ContainerImage.fromAsset(root, { file: 'apps/web/Dockerfile', platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64 });

    const apiLog = new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const webLog = new logs.LogGroup(this, 'WebLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const workerLog = new logs.LogGroup(this, 'WorkerLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const apiContainer = task.addContainer('api', {
      image: apiImage,
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLog, streamPrefix: 'api' }),
      environment: { ...sharedEnvironment, WEB_ORIGIN: 'same-host', AUTO_MIGRATE: 'true', AUTO_SEED_ADMIN: 'true', ADMIN_EMAIL: adminEmail },
      secrets: { ...sharedSecrets, JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret), ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPassword) },
      memoryReservationMiB: 384,
    });
    apiContainer.addPortMappings({ containerPort: 3001 });
    const webContainer = task.addContainer('web', {
      image: webImage,
      logging: ecs.LogDrivers.awsLogs({ logGroup: webLog, streamPrefix: 'web' }),
      memoryReservationMiB: 512,
    });
    webContainer.addPortMappings({ containerPort: 3000 });
    const workerContainer = task.addContainer('worker', {
      image: apiImage,
      command: ['npm', 'run', 'worker:aws', '-w', '@fleetflow/api'],
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLog, streamPrefix: 'worker' }),
      environment: {
        ...sharedEnvironment,
        ASSIGNMENT_QUEUE_URL: assignment.live.queueUrl,
        NOTIFICATION_QUEUE_URL: notification.live.queueUrl,
        EVENT_BUS_NAME: bus.eventBusName,
      },
      secrets: sharedSecrets,
      memoryReservationMiB: 384,
    });
    workerContainer.addContainerDependencies({ container: apiContainer, condition: ecs.ContainerDependencyCondition.START });

    assignment.live.grantSendMessages(task.taskRole);
    assignment.live.grantConsumeMessages(task.taskRole);
    notification.live.grantConsumeMessages(task.taskRole);
    bus.grantPutEventsTo(task.taskRole);
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [appSecurityGroup],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      healthCheckGracePeriod: cdk.Duration.minutes(5),
    });
    service.node.addDependency(database, cache);

    const lb = new elbv2.ApplicationLoadBalancer(this, 'InternalLoadBalancer', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: albSecurityGroup,
    });
    const webTarget = new elbv2.ApplicationTargetGroup(this, 'WebTarget', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [service.loadBalancerTarget({ containerName: 'web', containerPort: 3000 })],
      healthCheck: { path: '/', healthyHttpCodes: '200' },
    });
    const apiTarget = new elbv2.ApplicationTargetGroup(this, 'ApiTarget', {
      vpc,
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [service.loadBalancerTarget({ containerName: 'api', containerPort: 3001 })],
      healthCheck: { path: '/api/ready', healthyHttpCodes: '200' },
    });
    const listener = lb.addListener('Listener', { port: 80, defaultTargetGroups: [webTarget] });
    listener.addTargetGroups('ApiRoute', { priority: 10, conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*', '/ws'])], targetGroups: [apiTarget] });
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: apiTarget.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
    });

    const httpVpcOrigin = new cloudfront.VpcOrigin(this, 'HttpVpcOrigin', {
      endpoint: cloudfront.VpcOriginEndpoint.applicationLoadBalancer(lb),
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });
    const origin = origins.VpcOrigin.withVpcOrigin(httpVpcOrigin);
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      comment: 'FleetFlow demo HTTPS and WebSocket entry point',
    });

    new cdk.CfnOutput(this, 'Url', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'AdminEmail', { value: adminEmail });
    new cdk.CfnOutput(this, 'AdminPasswordSecretArn', { value: adminPassword.secretArn });
    new cdk.CfnOutput(this, 'DatabaseSecretArn', { value: database.secret!.secretArn });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });

    if (teardownAt) {
      const teardownRole = new iam.Role(this, 'TeardownRole', {
        assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      });
      teardownRole.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudformation:DeleteStack'],
        resources: [this.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: `${this.stackName}/*` })],
      }));
      new scheduler.CfnSchedule(this, 'AutoTeardown', {
        scheduleExpression: `at(${teardownAt.slice(0, -1)})`,
        scheduleExpressionTimezone: 'UTC',
        flexibleTimeWindow: { mode: 'OFF' },
        target: {
          arn: 'arn:aws:scheduler:::aws-sdk:cloudformation:deleteStack',
          roleArn: teardownRole.roleArn,
          input: JSON.stringify({ StackName: this.stackName }),
        },
      });
      new cdk.CfnOutput(this, 'TeardownAtUtc', { value: teardownAt });
    }

  }
}

class FleetFlowBudgetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps, email: string) {
    super(scope, id, props);
    const subscriber = { subscriptionType: 'EMAIL', address: email };
    new budgets.CfnBudget(this, 'AccountBudget', {
      budget: {
        budgetName: 'FleetFlow-demo-account-alert',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers: [subscriber] },
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers: [subscriber] },
        { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers: [subscriber] },
      ],
    });
  }
}

const stack = new FleetFlowStack(app, 'FleetFlow', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  description: 'Cost-conscious FleetFlow demo in Hyderabad: ECS, RDS PostgreSQL, Valkey, SQS, EventBridge, CloudFront',
});
cdk.Tags.of(stack).add('Project', 'FleetFlow');
if (budgetEmail) {
  const budgetStack = new FleetFlowBudgetStack(app, 'FleetFlowBudget', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
    description: 'Account-wide FleetFlow AWS Budget email alerts',
  }, String(budgetEmail));
  cdk.Tags.of(budgetStack).add('Project', 'FleetFlow');
}
