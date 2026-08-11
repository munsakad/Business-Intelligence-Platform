from pydantic import BaseModel


class QueryRequest(BaseModel):
    question: str


class ForecastRequest(BaseModel):
    date_column: str
    value_column: str
    periods: int = 12
    # "day" | "week" | "month"
    granularity: str = "month"
