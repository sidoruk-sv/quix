package quix.presto.download

import java.util.concurrent.{CountDownLatch, LinkedBlockingQueue, TimeUnit}

import com.typesafe.scalalogging.LazyLogging
import monix.eval.Task
import quix.api.execute._
import quix.presto.rest.Results
import quix.presto.{Download, PrestoEvent}

class DownloadResultBuilder(delegate: ResultBuilder[Results],
                            downloadableQueries: DownloadableQueries[Results, PrestoEvent],
                            consumer: Consumer[PrestoEvent],
                            downloadConfig: DownloadConfig)
  extends ResultBuilder[Results] with LazyLogging {
  var sentColumns = scala.collection.mutable.Map.empty[String, Boolean].withDefaultValue(false)

  override def start(query: ActiveQuery): Task[Unit] = delegate.start(query)

  override def end(query: ActiveQuery): Task[Unit] = {
    for {
      _ <- delegate.end(query)
    } yield ()
  }

  override def error(queryId: String, e: Throwable): Task[Unit] = {
    for {
      _ <- Task {
        downloadableQueries.get(queryId).forall(_.results.add(ErrorDuringDownload(e.getMessage)))
      }
      _ <- stopQuery(queryId)
      _ <- delegate.error(queryId, e)
    } yield ()
  }

  override def rowCount: Long = delegate.rowCount

  override def lastError: Option[Throwable] = delegate.lastError

  override def startSubQuery(queryId: String, code: String, results: Results): Task[Unit] = {
    val queue = new LinkedBlockingQueue[DownloadPayload](1)
    val latch = new CountDownLatch(1)
    downloadableQueries.add(DownloadableQuery(queryId, queue, isRunning = true, latch))

    for {
      _ <- delegate.startSubQuery(queryId, code, results.copy(data = List.empty))
      _ <- consumer.write(Download(queryId, "/api/download/" + queryId))
      downloadStarted <- Task {
        logger.info(s"event=wait-for-download-to-start timeout=${downloadConfig.waitTimeForDownloadInMillis}")
        latch.await(downloadConfig.waitTimeForDownloadInMillis, TimeUnit.MILLISECONDS)
      }
      _ <- if (!downloadStarted) {
        val exception = new IllegalStateException("Download failed to start within " + downloadConfig.waitTimeForDownloadInMillis / 1000 + " seconds")

        delegate.errorSubQuery(queryId, exception)
        Task.raiseError(exception)
      } else Task.unit
      _ <- addSubQuery(queryId, results)
    } yield ()
  }

  override def addSubQuery(queryId: String, results: Results): Task[Unit] = {
    val columnsTask = {
      val columns = results.columns.getOrElse(Nil).map(_.name)
      if (!sentColumns(queryId) && columns.nonEmpty) {
        Task {
          downloadableQueries.get(queryId).forall(_.results.add(DownloadableRow(columns)))
          sentColumns.put(queryId, true)
        }
      } else Task.unit
    }

    val rowsTask = Task {
      for {
        query <- downloadableQueries.get(queryId)
        row <- results.data}
        query.results.put(DownloadableRow(row))
    }

    for {
      _ <- columnsTask
      _ <- delegate.addSubQuery(queryId, results.copy(data = List.empty))
      _ <- rowsTask
    } yield ()
  }

  override def endSubQuery(queryId: String): Task[Unit] = {
    for {
      _ <- stopQuery(queryId)
      _ <- delegate.endSubQuery(queryId)
    } yield ()
  }

  override def errorSubQuery(queryId: String, e: Throwable): Task[Unit] = {
    for {
      _ <- Task {
        downloadableQueries.get(queryId).forall(_.results.add(ErrorDuringDownload(e.getMessage)))
      }
      _ <- stopQuery(queryId)
      _ <- delegate.errorSubQuery(queryId, e)
    } yield ()
  }

  def stopQuery(queryId: String) = {
    for {
      _ <- Task {
        downloadableQueries.get(queryId).foreach { query =>
          query.isRunning = false
        }
      }
    } yield ()
  }
}

