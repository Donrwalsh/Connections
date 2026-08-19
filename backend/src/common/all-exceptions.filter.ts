import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

/**
 * Extracts the response message NestJS would already send for an
 * HttpException — a plain string for `new BadRequestException("...")`, or
 * the `message` field (string or string[]) for exceptions whose response is
 * an object, e.g. ValidationPipe's array of per-field errors. Falls back to
 * `exception.message` only if neither shape applies.
 */
function extractMessage(exception: HttpException): string | string[] {
  const response = exception.getResponse();
  if (typeof response === "string") return response;
  if (response && typeof response === "object" && "message" in response) {
    const message = (response as { message: unknown }).message;
    if (typeof message === "string" || Array.isArray(message)) return message;
  }
  return exception.message;
}

/**
 * Single place every unhandled error in the app funnels through, so every
 * error response has the same shape (statusCode/message/timestamp/path)
 * regardless of which controller or service threw, and every 5xx gets
 * logged server-side with its stack — previously nothing did that
 * centrally; the app relied entirely on Nest's built-in default filter.
 * Known HttpExceptions (NotFoundException, the app's own
 * BadRequestExceptions, etc.) keep their existing status/message; anything
 * else collapses to a generic 500 body so internal error details never leak
 * to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = isHttpException ? extractMessage(exception) : "Internal server error";

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.originalUrl}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    });
  }
}
