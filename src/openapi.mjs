import { commands, schemas, securitySchemes, SERVER_URL, VERSION, validateCommands } from "./commands/index.mjs";

function operationFromCommand(command) {
  const operation = {
    operationId: command.operationId,
    summary: command.summary,
    responses: command.responses,
  };

  if (command.auth === "bearer") {
    operation.security = [{ ActionBearerAuth: [] }];
  }

  if (command.requestSchemaRef) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: command.requestSchemaRef },
        },
      },
    };
  }

  return operation;
}

function pathsFromCommands(commandList) {
  const paths = {};

  for (const command of commandList) {
    paths[command.path] ||= {};
    paths[command.path][command.method.toLowerCase()] = operationFromCommand(command);
  }

  return paths;
}

export function openApiDocument() {
  validateCommands(commands);

  return {
    openapi: "3.1.0",
    info: {
      title: "GitHub ADD API",
      version: VERSION,
      description: "Safe GitHub file read/create and marker-based or text-based patch preview/apply service for GPTS.",
    },
    servers: [
      {
        url: SERVER_URL,
        description: "Railway production",
      },
    ],
    paths: pathsFromCommands(commands),
    components: {
      securitySchemes,
      schemas,
    },
  };
}
