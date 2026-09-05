import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable, tap } from "rxjs";

/**
 * Logs method/path/status/duration for every HTTP request — the app had no
 * consistent request-level logging anywhere (see AllExceptionsFilter's own
 * doc comment for the matching gap on the error side). One line per
 * request, success or failure, instead of scattering ad hoc logger calls
 * across individual controllers.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, originalUrl } = request;
    const start = Date.now();

    // Only the success path logs here — a thrown error skips straight to
    // AllExceptionsFilter, which already logs 5xxs with a stack; a second
    // log line here would just be duplicate noise for the failure case.
    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse<Response>();
        this.logger.log(
          `${method} ${originalUrl} ${response.statusCode} - ${Date.now() - start}ms`,
        );
      }),
    );
  }
}
